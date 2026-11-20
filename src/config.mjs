import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Every segment name the footer knows. "title" (the thread name) is opt-in.
export const SEGMENTS = Object.freeze([
  "model",
  "mode",
  "title",
  "project",
  "context",
  "tokens",
  "limits",
  "cost",
  "env",
  "tools",
  "session",
  "state",
]);

export const DEFAULTS = Object.freeze({
  // Order of segments in the footer. Remove one to hide it; "mode", "title", "tokens", "env", "tools", "session" and "state" are opt-in.
  segments: Object.freeze([
    "model",
    "project",
    "context",
    "limits",
    "cost",
  ]),
  barWidth: 8,
  // Nerd Font glyphs instead of plain unicode.
  icons: false,
  // Show every rate-limit bucket instead of only the main "codex" one.
  allLimits: false,
  // Show staged (+), modified (~) and untracked (?) counts next to the git branch.
  showGitCounts: true,
  // Show prompt cache hit percentage in the tokens segment.
  showCacheRate: true,
  // Last shell command of the current turn, next to the tool counts.
  showLastCommand: true,
  // The in-progress step of the plan, next to its done/total count.
  showPlanCurrent: true,
  maxTools: 3,
  lastCommandWidth: 32,
  planCurrentWidth: 24,
  titleWidth: 32,
  // Percent thresholds for yellow / red.
  warn: 70,
  danger: 90,
});

// [min, max] for numeric options; out-of-range values are clamped.
export const RANGES = Object.freeze({
  barWidth: [1, 40],
  maxTools: [1, 10],
  lastCommandWidth: [4, 200],
  planCurrentWidth: [4, 200],
  titleWidth: [4, 200],
  warn: [0, 1000],
  danger: [0, 1000],
});
export const BOOLEANS = Object.freeze([
  "icons",
  "allLimits",
  "showGitCounts",
  "showCacheRate",
  "showLastCommand",
  "showPlanCurrent",
]);
export const MAX_CONFIG_BYTES = 64 * 1024;
const TTL_MS = 5000;

// Keeps only well-typed fields so a bad edit degrades to defaults instead of breaking the footer.
export function sanitize(user) {
  const cfg = { ...DEFAULTS };
  if (!user || typeof user !== "object" || Array.isArray(user)) return cfg;
  if (Array.isArray(user.segments)) {
    cfg.segments = [...new Set(user.segments.filter((s) => SEGMENTS.includes(s)))];
  }
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = user[key];
    if (typeof v === "number" && Number.isFinite(v)) cfg[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  for (const key of BOOLEANS) if (typeof user[key] === "boolean") cfg[key] = user[key];
  return cfg;
}

// Where the config comes from: CODEX_HUD_CONFIG, then $XDG_CONFIG_HOME, then ~/.config.
export function configSource(env = process.env) {
  if (env.CODEX_HUD_CONFIG) return { path: env.CODEX_HUD_CONFIG, from: "CODEX_HUD_CONFIG" };
  if (env.XDG_CONFIG_HOME) return { path: join(env.XDG_CONFIG_HOME, "codex-hud", "config.json"), from: "XDG_CONFIG_HOME" };
  return { path: join(homedir(), ".config", "codex-hud", "config.json"), from: "default" };
}

export function configPath(env = process.env) {
  return configSource(env).path;
}

async function readUserConfig(path) {
  try {
    if ((await stat(path)).size > MAX_CONFIG_BYTES) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null; // missing or invalid: defaults
  }
}

let current = null;
let loadedAt = 0;
let pending = null;

// Async and cached: re-reads at most every 5 s so edits apply without restarting Codex,
// and a slow filesystem never blocks a poll once a config has been loaded.
export function loadConfig(now = Date.now()) {
  if (!pending && (!current || now - loadedAt > TTL_MS)) {
    pending = readUserConfig(configPath()).then((user) => {
      current = sanitize(user);
      loadedAt = Date.now();
      pending = null;
      return current;
    });
  }
  return current ? Promise.resolve(current) : pending;
}

export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex");
}
