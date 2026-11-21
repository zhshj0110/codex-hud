// Snapshot (com.openai/codex-statusline-state) + local data -> Codex UI tree.
import { basename } from "node:path";
import { runningCounts } from "./transcript.mjs";

const PLAIN = {
  sep: "│",
  model: "",
  folder: "",
  branch: "⎇",
  dirty: "*",
  ahead: "↑",
  behind: "↓",
  reset: "↻",
  tools: "⚙",
  plan: "☑",
  clock: "⏱",
  fast: "⚡",
  cost: "$",
  running: "◐",
  mode: "◈",
  edit: "✎",
};
const NERD = {
  ...PLAIN,
  sep: "│",
  model: "\uee9c",
  folder: "",
  branch: "",
  reset: "",
  tools: "",
  plan: "",
  clock: "",
  fast: "",
  mode: "",
  edit: "",
};

// Upper bound on any single piece of text taken from the snapshot, git or the transcript.
const MAX_FIELD = 48;
// Upper bound on rate-limit meters (each window is one meter).
const MAX_METERS = 6;

export const GLYPHS = Object.freeze({ plain: PLAIN, nerd: NERD });

// Truncates to `max` code points (never splits a surrogate pair).
export function clip(value, max = MAX_FIELD) {
  const s = String(value);
  if (s.length <= max) return s;
  const chars = Array.from(s.slice(0, max * 2));
  if (chars.length <= max && s.length <= max * 2) return s;
  return `${chars.slice(0, max - 1).join("")}…`;
}

// One line of plain text: control characters (newlines, ESC, …) and bidi overrides
// become spaces, runs of whitespace collapse. Long input is cut before cleaning.
export function oneLine(value, limit = 1024) {
  return String(value)
    .slice(0, limit)
    .replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Width options may come from an unsanitized config.
const width = (v, fallback) => (Number.isFinite(v) ? Math.max(4, Math.min(200, Math.round(v))) : fallback);

const text = (value, color, extra) => ({
  type: "text",
  props: { color: color ?? null, ...extra },
  children: [String(value)],
});
const row = (children, gap = 1, wrap = "nowrap") => ({
  type: "row",
  props: { gap, wrap },
  children,
});

// Colour policy (measured in the Codex 0.171 TUI):
// - status-* colours are taken from the active /theme, so everything in the normal
//   state uses them (or null = default foreground).
// - ANSI names come from the terminal palette and ignore /theme; they are kept only
//   for warn/danger, together with a "!" / "!!" marker because some themes make the
//   normal meter colour amber/red already (e.g. one-half-light status-limit).
// - "surface" is the theme background (invisible as text) and "accent" emits no
//   colour at all, so neither is used.
export const ALERTS = {
  warn: { color: "yellow", mark: "!" },
  danger: { color: "red", mark: "!!" },
};

// Severity of the value as displayed, so "70%" is never shown as normal when warn = 70.
export function level(pct, cfg) {
  const shown = Math.round(pct);
  if (shown >= cfg.danger) return "danger";
  if (shown >= cfg.warn) return "warn";
  return "ok";
}

export function bar(pct, width) {
  width = Math.max(1, Math.min(40, Math.round(width) || 1));
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  const full = Math.round((p / 100) * width);
  return "█".repeat(full) + "░".repeat(width - full);
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "0m";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return h ? `${d}d${h}h` : `${d}d`;
  if (h) return m ? `${h}h${m}m` : `${h}h`;
  if (m) return `${m}m`;
  return `${Math.floor(sec)}s`;
}

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function windowLabel(minutes) {
  if (!minutes) return "limit";
  if (minutes === 10080) return "7d";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// label + bar in the segment's theme colour; percentage in the default foreground.
// At warn/danger the bar switches to ANSI yellow/red and a marker precedes the value.
function meter(label, pct, cfg, themeColor) {
  const alert = ALERTS[level(pct, cfg)];
  const parts = [text(label, themeColor), text(bar(pct, cfg.barWidth), alert ? alert.color : themeColor)];
  if (alert) parts.push(text(alert.mark, alert.color, { weight: "bold" }));
  parts.push(text(`${Math.round(pct)}%`, null, { weight: "bold" }));
  return parts;
}

const segments = {
  model({ thread }, _ctx, g) {
    const m = thread.model || {};
    const name = clip(m.display_name || m.id || "codex");
    const parts = [text(g.model ? `${g.model} ${name}` : name, "status-model", { weight: "bold" })];
    if (m.reasoning_level) parts.push(text(clip(m.reasoning_level, 16), "status-model"));
    const tier = (m.service_tier || "").toLowerCase();
    if (tier === "fast" || tier === "priority") parts.push(text(g.fast, "status-model"));
    if (typeof m.provider === "string" && m.provider && m.provider.toLowerCase() !== "openai") {
      parts.push(text(clip(oneLine(m.provider), 16), "status-metadata"));
    }
    return row(parts);
  },

  mode({ thread, config, app }, _ctx, g) {
    const perm = thread.permissions && typeof thread.permissions === "object" ? thread.permissions : null;
    const appr = thread.approval && typeof thread.approval === "object" ? thread.approval : null;
    const profile = config && typeof config.profile === "string" ? oneLine(config.profile) : "";
    const rawMode = app && app.display_mode === "raw";

    let permLabel = "";
    if (perm) {
      if (typeof perm.display_name === "string" && perm.display_name.trim()) {
        permLabel = clip(oneLine(perm.display_name), 20);
      } else if (perm.type === "disabled") {
        permLabel = "full-access";
      } else if (perm.type === "managed") {
        const fs = perm.file_system && perm.file_system.type === "unrestricted" ? "unrestricted" : "sandbox";
        permLabel = perm.network === "enabled" ? `${fs}+net` : fs;
      } else if (perm.type === "external") {
        permLabel = perm.network === "enabled" ? "external+net" : "external";
      }
    }

    let apprLabel = "";
    if (appr) {
      if (appr.reviewer === "auto-review") apprLabel = "auto-review";
      else if (typeof appr.policy === "string" && appr.policy) apprLabel = clip(oneLine(appr.policy), 16);
    }

    const modeBits = [];
    if (permLabel) modeBits.push(permLabel);
    if (apprLabel && !permLabel.toLowerCase().includes(apprLabel.toLowerCase())) modeBits.push(apprLabel);

    const parts = [];
    if (modeBits.length) parts.push(text(`${g.mode} ${modeBits.join("·")}`, "status-mode"));
    if (profile) parts.push(text(`@${clip(profile, 16)}`, "status-metadata"));
    if (rawMode) parts.push(text("raw", "status-metadata"));
    return parts.length ? row(parts) : null;
  },

  project({ thread }, ctx, g) {
    const cwd = thread.workspace && thread.workspace.cwd;
    if (!cwd) return null;
    const dir = clip(basename(cwd) || cwd);
    const dirNode = text(g.folder ? `${g.folder} ${dir}` : dir, "status-path");
    const git = ctx.git;
    if (git && git.branch) {
      const gitParts = [];
      let b = `${g.branch} ${clip(git.branch)}`;
      if (git.dirty) b += g.dirty;
      gitParts.push(text(b, "status-branch"));
      if (ctx.cfg.showGitCounts !== false) {
        const counts = [
          git.staged ? `+${git.staged}` : "",
          git.modified ? `~${git.modified}` : "",
          git.untracked ? `?${git.untracked}` : "",
        ]
          .filter(Boolean)
          .join("");
        if (counts) gitParts.push(text(counts, "status-metadata"));
      }
      const sync = `${git.ahead ? g.ahead + git.ahead : ""}${git.behind ? g.behind + git.behind : ""}`;
      if (sync) gitParts.push(text(sync, "status-metadata"));
      return [dirNode, row(gitParts)];
    }
    return dirNode;
  },

  context({ thread }, ctx) {
    const c = (thread.usage && thread.usage.context) || {};
    const a = ctx.activity;
    let used = c.used_tokens;
    let win = c.context_window_size || (a && a.contextWindow) || ctx.contextWindow || null;
    let pct = c.used_percentage;
    if (pct == null && used == null && a && Number.isFinite(a.lastContextTokens) && Number.isFinite(win) && win > 0) {
      used = a.lastContextTokens;
    }
    if (pct == null && used == null) {
      used = win ? 0 : null;
      pct = 0;
    }
    if (pct == null && used != null && win) {
      pct = (used / win) * 100;
    }
    if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
    const parts = meter("Context", pct, ctx.cfg, "status-usage");
    if (used != null && win) {
      parts.push(text(`${fmtTokens(used)}/${fmtTokens(win)}`, "status-metadata"));
    }
    return row(parts);
  },

  tokens({ thread }, ctx, g) {
    const snap = thread.usage && thread.usage.total && typeof thread.usage.total === "object" ? thread.usage.total : null;
    const fallback = ctx.activity && ctx.activity.tokenUsage ? ctx.activity.tokenUsage : null;
    const pick = (src) => {
      if (!src) return null;
      const inp = Number.isFinite(src.total_input_tokens)
        ? src.total_input_tokens
        : Number.isFinite(src.input_tokens)
          ? src.input_tokens
          : 0;
      const out = Number.isFinite(src.output_tokens) ? src.output_tokens : 0;
      const cacheRead = Number.isFinite(src.cache_read_input_tokens)
        ? src.cache_read_input_tokens
        : Number.isFinite(src.cached_input_tokens)
          ? src.cached_input_tokens
          : 0;
      return inp > 0 || out > 0 ? { inp, out, cacheRead } : null;
    };
    const data = pick(snap) || pick(fallback);
    if (!data) return null;
    const parts = [text(`${g.ahead}${fmtTokens(data.inp)} ${g.behind}${fmtTokens(data.out)}`, "status-metadata")];
    if (ctx.cfg.showCacheRate !== false && data.inp > 0) {
      const pct = Math.min(100, Math.max(0, Math.round((data.cacheRead / data.inp) * 100)));
      parts.push(text(`cache ${pct}%`, "status-usage"));
    }
    return row(parts);
  },

  limits({ account }, ctx, g) {
    let snaps = (account && account.rate_limits) || [];
    if (!snaps.length && Array.isArray(ctx.rateLimits)) snaps = ctx.rateLimits;
    if (!ctx.cfg.allLimits) {
      const main = snaps.find((s) => s.limit_id === "codex") || snaps[0];
      snaps = main ? [main] : [];
    }
    const out = [];
    for (const s of snaps) {
      const prefix = ctx.cfg.allLimits && s.limit_id !== "codex" ? `${clip(s.limit_name || s.limit_id, 16)} ` : "";
      for (const w of [s.primary_limit, s.secondary_limit]) {
        if (!w || typeof w.used_percent !== "number" || out.length >= MAX_METERS) continue;
        const parts = meter(prefix + windowLabel(w.window_minutes), w.used_percent, ctx.cfg, "status-limit");
        if (out.length === 0) parts.unshift(text("Usage", "status-limit"));
        if (w.resets_at) {
          const left = w.resets_at - ctx.now / 1000;
          if (left > 0) parts.push(text(`${g.reset}${fmtDuration(left)}`, "status-metadata"));
        }
        out.push(row(parts));
      }
    }
    return out.length ? (out.length === 1 ? out[0] : row(out, 2)) : null;
  },

  cost({ thread }, _ctx, g) {
    const cost = thread.usage && thread.usage.cost;
    if (!cost) return null;
    if (cost.total_cost_usd) return text(`${g.cost}${cost.total_cost_usd.toFixed(2)}`, "status-metadata");
    if (cost.total_credits) return text(`${cost.total_credits} cr`, "status-metadata");
    return null;
  },

  env(_state, ctx) {
    const e = ctx.env;
    if (!e || typeof e !== "object") return null;
    const bits = [];
    if (e.agentsMd > 0) bits.push(`${e.agentsMd} AGENTS`);
    if (e.mcps > 0) bits.push(`${e.mcps} ${e.mcps === 1 ? "MCP" : "MCPs"}`);
    if (e.skills > 0) bits.push(`${e.skills} ${e.skills === 1 ? "skill" : "skills"}`);
    return bits.length ? text(bits.join("·"), "status-metadata") : null;
  },

  tools(_state, ctx, g) {
    const a = ctx.activity;
    if (!a) return null;
    const cfg = ctx.cfg;
    const max = Math.max(1, Math.min(10, Math.round(cfg.maxTools) || 3));
    const parts = [];
    if (a.plan && a.plan.total) {
      const done = a.plan.done === a.plan.total;
      parts.push(text(`${g.plan} ${a.plan.done}/${a.plan.total}`, "status-progress", done ? { weight: "bold" } : undefined));
      const step = cfg.showPlanCurrent && a.plan.current ? oneLine(a.plan.current) : "";
      if (step) parts.push(text(clip(step, width(cfg.planCurrentWidth, 24)), "status-progress"));
    }
    const list = (counts) =>
      [...counts.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, max)
        .map(([n, c]) => (c > 1 ? `${clip(n, 24)}×${c}` : clip(n, 24)))
        .join(" ");
    // Calls still waiting for their output, then the finished ones of this turn.
    const running = runningCounts(a);
    if (running.size) parts.push(text(`${g.running} ${list(running)}`, "status-state"));
    const done = new Map();
    for (const [n, c] of a.tools || []) {
      const left = c - (running.get(n) || 0);
      if (left > 0) done.set(n, left);
    }
    if (done.size) parts.push(text(`${g.tools} ${list(done)}`, "status-metadata"));
    if (cfg.showLastCommand && a.lastCommand) {
      const cmd = oneLine(a.lastCommand);
      if (cmd) parts.push(text(clip(cmd, Math.max(4, Math.round(cfg.lastCommandWidth) || 4)), "status-metadata", { italic: true }));
    }
    return parts.length ? row(parts) : null;
  },

  session(_state, ctx, g) {
    const a = ctx.activity;
    if (!a) return null;
    const parts = [];
    if (Number.isFinite(a.sessionStartedAt)) {
      const elapsed = Math.max(0, (ctx.now - a.sessionStartedAt) / 1000);
      parts.push(text(`${g.clock} ${fmtDuration(elapsed)}`, "status-metadata"));
    }
    if (a.turns > 0) parts.push(text(`#${a.turns}`, "status-metadata"));
    const edited = a.editedFiles instanceof Set ? a.editedFiles.size : 0;
    if (edited > 0) parts.push(text(`${g.edit} ${edited}`, "status-metadata"));
    return parts.length ? row(parts) : null;
  },

  title({ thread }, ctx) {
    if (typeof thread.name !== "string") return null;
    const name = oneLine(thread.name);
    return name ? text(clip(name, width(ctx.cfg.titleWidth, 32)), "status-thread", { weight: "bold" }) : null;
  },

  state({ thread }, ctx, g) {
    const s = thread.agent && thread.agent.state;
    if (!s || s === "ready") return null;
    // status-mode and status-state share a colour in the themes measured, so "waiting"
    // (needs the user) is told apart by its glyph instead.
    const glyph = s === "waiting" ? "◌" : "●";
    const color = s === "starting" ? "status-metadata" : "status-state";
    const parts = [text(`${glyph} ${clip(s, 16)}`, color, { weight: "bold" })];
    const started = ctx.activity && ctx.activity.turnStartedAt;
    if (started && (s === "working" || s === "thinking")) {
      parts.push(text(`${g.clock} ${fmtDuration((ctx.now - started) / 1000)}`, "status-metadata"));
    }
    return row(parts);
  },
};

// Spacing between groups, which carry no separator.
export const GROUP_GAP = 3;

export function render(state, { cfg, git = null, env = null, activity = null, contextWindow = null, rateLimits = null, now = Date.now() }) {
  if (!state || typeof state !== "object" || !state.thread || typeof state.thread !== "object") return null;
  const g = cfg.icons ? NERD : PLAIN;
  const ctx = { cfg, git, env, activity, contextWindow, rateLimits, now };
  // Without "groups" items sit directly in the wrapping row, so Codex may wrap between any two.
  // With it each group is its own wrapping row, which Codex moves to a new line as a block.
  // Groups apply only when they list exactly cfg.segments (sanitize keeps them in step).
  const grouped =
    Array.isArray(cfg.groups) && cfg.groups.length > 0 && cfg.groups.every(Array.isArray) &&
    cfg.groups.flat().join() === cfg.segments.join();
  const groups = grouped ? cfg.groups : [cfg.segments];
  const out = [];
  let prevName = null;
  for (const names of groups) {
    const items = grouped ? [] : out;
    for (const name of names) {
      const fn = segments[name];
      if (!fn) continue;
      let el = null;
      try {
        el = fn(state, ctx, g);
      } catch {
        el = null; // a bad field in one segment must not blank the whole footer
      }
      if (!el) continue;
      for (const e of Array.isArray(el) ? el : [el]) {
        // No separator between groups: Codex may wrap there, which would leave it dangling.
        if (items.length && prevName !== "limits") items.push(text(g.sep, "status-metadata"));
        items.push(e);
        prevName = name;
      }
    }
    if (grouped && items.length) out.push(row(items, 1, "wrap"));
  }
  return out.length ? row(out, grouped ? GROUP_GAP : 1, "wrap") : null;
}

// Renders and guarantees the result fits Codex's limits: an oversize reply would stop polling.
// Falls back to a minimal footer, then to clearing it.
export const FALLBACK_SEGMENTS = ["model", "context"];

export function renderSafe(state, opts) {
  const tree = render(state, opts);
  if (checkLimits(tree).ok) return tree;
  const small = render(state, { ...opts, cfg: { ...opts.cfg, groups: null, segments: FALLBACK_SEGMENTS } });
  return checkLimits(small).ok ? small : null;
}

// ---- terminal preview (development only; Codex renders the tree itself) ----

// SGR codes as captured from the real Codex TUI, so the preview shows what Codex shows.
const ANSI_NAMES = { black: "30", red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36", white: "37" };
const rgb = (r, g, b) => `38;2;${r};${g};${b}`;
export const PREVIEW_THEMES = {
  dracula: {
    primary: rgb(248, 248, 242), surface: rgb(40, 42, 54),
    "status-model": rgb(102, 217, 239), "status-path": rgb(241, 250, 140), "status-branch": rgb(80, 250, 123),
    "status-metadata": rgb(98, 114, 164), "status-usage": rgb(189, 147, 249), "status-limit": rgb(189, 147, 249),
    "status-state": rgb(255, 121, 198), "status-mode": rgb(255, 121, 198), "status-progress": rgb(80, 250, 123),
    "status-thread": rgb(248, 248, 242),
  },
  "one-half-light": {
    primary: rgb(56, 58, 66), surface: rgb(250, 250, 250),
    "status-model": rgb(228, 86, 73), "status-path": rgb(80, 161, 79), "status-branch": rgb(1, 132, 188),
    "status-metadata": rgb(160, 161, 167), "status-usage": rgb(193, 132, 1), "status-limit": rgb(193, 132, 1),
    "status-state": rgb(166, 38, 164), "status-mode": rgb(166, 38, 164), "status-progress": rgb(152, 195, 121),
    "status-thread": rgb(56, 58, 66),
  },
};

export function toAnsi(node, style = {}, theme = "dracula") {
  if (node == null) return "";
  if (typeof node === "string") {
    const codes = [];
    if (style.color) {
      const hex = /^#([0-9a-f]{6})$/i.exec(style.color);
      const palette = PREVIEW_THEMES[theme] || PREVIEW_THEMES.dracula;
      if (hex) {
        const n = parseInt(hex[1], 16);
        codes.push(rgb(n >> 16, (n >> 8) & 255, n & 255));
      } else if (ANSI_NAMES[style.color]) codes.push(ANSI_NAMES[style.color]);
      else if (palette[style.color]) codes.push(palette[style.color]);
    }
    if (style.bold) codes.push(1);
    if (style.italic) codes.push(3);
    if (style.underline) codes.push(4);
    return codes.length ? `\x1b[${codes.join(";")}m${node}\x1b[0m` : node;
  }
  const p = node.props || {};
  const next = { ...style };
  if (node.type === "text") {
    if (p.color) next.color = p.color;
    if (p.weight === "bold") next.bold = true;
    if (p.italic) next.italic = true;
    if (p.underline) next.underline = true;
  }
  if (node.type === "bold") next.bold = true;
  if (node.type === "italic") next.italic = true;
  if (node.type === "underline") next.underline = true;
  const kids = (node.children || []).map((c) => toAnsi(c, next, theme)).filter(Boolean);
  return node.type === "row" ? kids.join(" ".repeat(p.gap || 0)) : kids.join("");
}

// Mirrors the limits Codex enforces on a UI tree.
export function checkLimits(tree) {
  const json = JSON.stringify(tree);
  let nodes = 0;
  let textBytes = 0;
  let depth = 0;
  const walk = (n, d) => {
    if (n == null) return;
    nodes++;
    depth = Math.max(depth, d);
    if (typeof n === "string") {
      textBytes += Buffer.byteLength(n);
      return;
    }
    for (const c of n.children || []) walk(c, d + 1);
  };
  walk(tree, 0);
  return {
    ok: Buffer.byteLength(json) <= 64 * 1024 && nodes <= 256 && depth <= 16 && textBytes <= 16 * 1024,
    bytes: Buffer.byteLength(json),
    nodes,
    depth,
    textBytes,
  };
}
