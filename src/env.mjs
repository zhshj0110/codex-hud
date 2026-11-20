// Lightweight, cached environment summary (AGENTS.md, MCP servers, skills) for the `env` segment.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const TTL_MS = 30_000;
const MAX_ENTRIES = 16;
const cache = new Map(); // `${codexHome}\0${cwd}` -> { at, info, pending }

// Count distinct `[mcp_servers.<name>]` entries in config.toml (ignoring comments & multiline strings).
export function countMcpServers(toml) {
  if (typeof toml !== "string" || !toml) return 0;
  const names = new Set();
  let multi = null;
  for (const raw of toml.split(/\r?\n/)) {
    if (multi) {
      if (raw.includes(multi)) multi = null;
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const triple = /("""|''')/.exec(line);
    if (triple) {
      const delim = triple[1];
      const first = line.indexOf(delim);
      if (line.indexOf(delim, first + 3) < 0) multi = delim;
      continue;
    }
    const m = /^\[\s*mcp_servers\.([A-Za-z0-9_-]+|"[^"]+"|'[^']+')\s*(?:\.|\])/.exec(line);
    if (m) names.add(m[1].replace(/^["']|["']$/g, ""));
  }
  return names.size;
}

async function isNonEmptyFile(path) {
  try {
    const st = await stat(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function countSkillDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory() || e.isSymbolicLink()) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function collectEnv(cwd, homeDir) {
  const agentFiles = [join(homeDir, "AGENTS.md")];
  if (cwd) {
    agentFiles.push(join(cwd, "AGENTS.md"), join(cwd, "AGENTS.override.md"));
  }
  const skillDirs = [join(homeDir, "skills")];
  if (cwd) {
    skillDirs.push(join(cwd, ".agents", "skills"), join(cwd, ".codex", "skills"));
  }
  const [agentChecks, skillCounts, toml] = await Promise.all([
    Promise.all(agentFiles.map(isNonEmptyFile)),
    Promise.all(skillDirs.map(countSkillDirs)),
    readFile(join(homeDir, "config.toml"), "utf8").catch(() => ""),
  ]);
  return {
    agentsMd: agentChecks.filter(Boolean).length,
    mcps: countMcpServers(toml),
    skills: skillCounts.reduce((a, b) => a + b, 0),
  };
}

export function envInfo(cwd, homeDir) {
  if (!homeDir) return { info: null, refresh: Promise.resolve(null) };
  const key = `${homeDir}\0${cwd || ""}`;
  let entry = cache.get(key);
  if (entry) cache.delete(key);
  else entry = { at: 0, info: null, pending: null };
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  if (!entry.pending && Date.now() - entry.at > TTL_MS) {
    entry.pending = collectEnv(cwd, homeDir)
      .then((info) => {
        entry.info = info;
        entry.at = Date.now();
        entry.pending = null;
        return info;
      })
      .catch(() => {
        entry.at = Date.now();
        entry.pending = null;
        return entry.info;
      });
  }
  return { info: entry.info, refresh: entry.pending || Promise.resolve(entry.info) };
}

export const _envCacheSize = () => cache.size;

const MODELS_TTL_MS = 60_000;
const modelsCache = new Map(); // homeDir -> { at, map, pending }

export function parseModelsCache(raw) {
  const map = new Map();
  if (typeof raw !== "string" || !raw) return map;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return map;
  }
  const list = Array.isArray(data) ? data : Array.isArray(data && data.models) ? data.models : [];
  for (const m of list) {
    if (!m || typeof m !== "object" || !Number.isFinite(m.context_window) || m.context_window <= 0) continue;
    if (typeof m.slug === "string" && m.slug) map.set(m.slug.toLowerCase(), m.context_window);
    if (typeof m.display_name === "string" && m.display_name) map.set(m.display_name.toLowerCase(), m.context_window);
  }
  return map;
}

export function modelsInfo(homeDir) {
  if (!homeDir) return { map: null, refresh: Promise.resolve(null) };
  let entry = modelsCache.get(homeDir);
  if (!entry) {
    entry = { at: 0, map: null, pending: null };
    modelsCache.set(homeDir, entry);
  }
  if (!entry.pending && Date.now() - entry.at > MODELS_TTL_MS) {
    entry.pending = readFile(join(homeDir, "models_cache.json"), "utf8")
      .then((raw) => {
        entry.map = parseModelsCache(raw);
        entry.at = Date.now();
        entry.pending = null;
        return entry.map;
      })
      .catch(() => {
        entry.at = Date.now();
        entry.pending = null;
        return entry.map;
      });
  }
  return { map: entry.map, refresh: entry.pending || Promise.resolve(entry.map) };
}

export function lookupContextWindow(map, model) {
  if (!(map instanceof Map) || !model || typeof model !== "object") return null;
  for (const key of [model.id, model.display_name]) {
    if (typeof key === "string" && key) {
      const hit = map.get(key.toLowerCase());
      if (hit) return hit;
    }
  }
  return null;
}

const RATE_TTL_MS = 30_000;
const UNKNOWN_RESET_TTL_MS = 5 * 60_000;
const RATE_TAIL_BYTES = 128 * 1024;
const rateCache = new Map(); // homeDir -> { at, sample, pending }

export function freshRateLimits({ snaps, observedAt }, now) {
  const fresh = (window) => {
    if (!window) return null;
    const reset = window.resets_at;
    if (Number.isFinite(reset) && reset > 0) return now < reset * 1000 ? window : null;
    return Number.isFinite(observedAt) && now < observedAt + UNKNOWN_RESET_TTL_MS ? window : null;
  };
  const filtered = [];
  let changed = false;
  for (const snap of snaps) {
    const primary = fresh(snap?.primary_limit);
    const secondary = fresh(snap?.secondary_limit);
    if (!primary && !secondary) {
      changed = true;
    } else if (primary !== (snap.primary_limit ?? null) || secondary !== (snap.secondary_limit ?? null)) {
      changed = true;
      filtered.push({ ...snap, primary_limit: primary, secondary_limit: secondary });
    } else {
      filtered.push(snap);
    }
  }
  return changed ? filtered : snaps;
}

export function mergeRateLimits(preferred, fallback) {
  const byId = new Map(fallback.map((snap) => [snap.limit_id, snap]));
  const merged = preferred.map((snap) => {
    const local = byId.get(snap.limit_id);
    byId.delete(snap.limit_id);
    return local ? {
      ...snap,
      primary_limit: snap.primary_limit ?? local.primary_limit,
      secondary_limit: snap.secondary_limit ?? local.secondary_limit,
    } : snap;
  });
  return merged.concat([...byId.values()]);
}

export function normalizeRateLimits(rl) {
  if (!rl || typeof rl !== "object") return null;
  const primary = rl.primary_limit ?? rl.primary ?? null;
  const secondary = rl.secondary_limit ?? rl.secondary ?? null;
  if (!primary && !secondary) return null;
  return [
    {
      limit_id: typeof rl.limit_id === "string" ? rl.limit_id : "codex",
      limit_name: typeof rl.limit_name === "string" ? rl.limit_name : null,
      primary_limit: primary,
      secondary_limit: secondary,
    },
  ];
}

async function listDesc(dir) {
  try {
    return (await readdir(dir)).sort().reverse();
  } catch {
    return [];
  }
}

async function readTailRateLimits(filePath, now) {
  let fh;
  try {
    fh = await open(filePath, "r");
    const st = await fh.stat();
    if (st.size <= 0) return null;
    const len = Math.min(st.size, RATE_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, st.size - len);
    if (bytesRead <= 0) return null;
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l || !l.includes('"token_count"')) continue;
      try {
        const o = JSON.parse(l);
        if (o && o.type === "event_msg" && o.payload && o.payload.type === "token_count" && o.payload.rate_limits) {
          const raw = normalizeRateLimits(o.payload.rate_limits);
          if (!raw) continue;
          const observedAt = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
          const snaps = freshRateLimits({ snaps: raw, observedAt }, now);
          if (snaps.length) return { snaps, observedAt };
        }
      } catch {}
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function collectRateLimitSample(homeDir, now) {
  const root = join(homeDir, "sessions");
  let checked = 0;
  for (const y of await listDesc(root)) {
    for (const m of await listDesc(join(root, y))) {
      for (const d of await listDesc(join(root, y, m))) {
        const dir = join(root, y, m, d);
        for (const f of await listDesc(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const sample = await readTailRateLimits(join(dir, f), now);
          if (sample) return sample;
          if (++checked >= 30) return null;
        }
      }
    }
  }
  return null;
}

export async function collectLatestRateLimits(homeDir, now = Date.now()) {
  return (await collectRateLimitSample(homeDir, now))?.snaps ?? null;
}

export function fallbackRateLimitsInfo(homeDir, now = Date.now(), { force = false } = {}) {
  if (!homeDir) return { snaps: null, refresh: Promise.resolve(null) };
  let entry = rateCache.get(homeDir);
  if (!entry) {
    entry = { at: -Infinity, sample: null, pending: null };
    rateCache.set(homeDir, entry);
  }
  if (entry.sample) {
    const snaps = freshRateLimits(entry.sample, now);
    if (snaps !== entry.sample.snaps) {
      entry.sample = snaps.length ? { ...entry.sample, snaps } : null;
      entry.at = -Infinity;
    }
  }
  if (!entry.pending && (force || now - entry.at >= RATE_TTL_MS)) {
    entry.pending = collectRateLimitSample(homeDir, now)
      .then((sample) => {
        if (sample) entry.sample = sample;
      })
      .catch(() => {})
      .finally(() => {
        entry.at = now;
        entry.pending = null;
      });
  }
  const snaps = entry.sample?.snaps ?? null;
  return { snaps, refresh: entry.pending ? entry.pending.then(() => entry.sample?.snaps ?? null) : Promise.resolve(snaps) };
}
