#!/usr/bin/env node
// codex-hud: a Codex CLI statusline provider (newline-delimited MCP over stdio).
//
// Codex polls `resources/read` on our advertised URI about once a second and
// passes the displayed thread's snapshot in
// params._meta["com.openai/codex-statusline-state"]. We answer with a UI tree.
// stdout carries JSON-RPC only; diagnostics go to stderr.
import { createInterface } from "node:readline";
import { codexHome, loadConfig, DEFAULTS } from "./src/config.mjs";
import { envInfo, fallbackRateLimitsInfo, freshRateLimits, lookupContextWindow, mergeRateLimits, modelsInfo } from "./src/env.mjs";
import { gitInfo } from "./src/git.mjs";
import { renderSafe, toAnsi, checkLimits } from "./src/render.mjs";
import { TranscriptWatcher } from "./src/transcript.mjs";

export const VERSION = "0.1.0";
export const URI = "ui://codex-hud/footer";
const STATE_KEY = "com.openai/codex-statusline-state";
// Codex gives each read 1 s; spend at most this long waiting for fresh local data.
const LOCAL_BUDGET_MS = 300;

export const TOOL = {
  name: "statusline",
  title: "codex-hud",
  description: "Status line provider for the Codex CLI footer. Not useful to call directly.",
  inputSchema: { type: "object", properties: {} },
  _meta: { "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: URI }] } },
};

const transcripts = new TranscriptWatcher(codexHome());
let lastSeenRateLimits = null;

// Resolves with the promise's value, or `fallback` once `ms` have passed.
const within = (p, ms, fallback) => {
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r(fallback), Math.max(0, ms));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

export async function buildTree(state, now = Date.now()) {
  if (process.env.CODEX_HUD_DISABLE === "1") return null;
  const deadline = Date.now() + LOCAL_BUDGET_MS;
  const cfg = (await within(loadConfig(now), LOCAL_BUDGET_MS / 2, null)) || DEFAULTS;
  const thread = state && typeof state.thread === "object" && state.thread ? state.thread : {};
  const cwd = thread.workspace && typeof thread.workspace.cwd === "string" ? thread.workspace.cwd : null;
  const id = typeof thread.id === "string" ? thread.id : null;
  const home = codexHome();
  const g = gitInfo(cwd);
  const wantsEnv = cfg.segments.includes("env");
  const e = wantsEnv ? envInfo(cwd, home) : { info: null, refresh: Promise.resolve(null) };
  const wantsModels = cfg.segments.includes("context") && !(thread.usage && thread.usage.context && thread.usage.context.context_window_size);
  const m = wantsModels ? modelsInfo(home) : { map: null, refresh: Promise.resolve(null) };
  const snapLimits = state && state.account && Array.isArray(state.account.rate_limits) ? state.account.rate_limits : [];
  if (snapLimits.length) lastSeenRateLimits = { snaps: snapLimits, observedAt: now, needsFallback: false };
  const cached = !snapLimits.length ? lastSeenRateLimits : null;
  const cachedLimits = cached ? freshRateLimits(cached, now) : [];
  const expired = cached && cachedLimits !== cached.snaps;
  if (expired) {
    cached.snaps = cachedLimits;
    cached.needsFallback = true;
  }
  const wantsRateFallback = cfg.segments.includes("limits") && !snapLimits.length && (!cached || cached.needsFallback);
  const r = wantsRateFallback ? fallbackRateLimitsInfo(home, now, { force: expired }) : { refresh: Promise.resolve() };
  const wantsActivity = cfg.segments.some((s) => s === "tools" || s === "state" || s === "session" || s === "tokens" || s === "context");
  const t = wantsActivity ? transcripts.update(id) : Promise.resolve(null);
  // Use whatever is ready within budget; the rest shows up on the next poll.
  await within(Promise.all([g.refresh, e.refresh, m.refresh, r.refresh, t]), deadline - Date.now());
  return renderSafe(state, {
    cfg,
    git: gitInfo(cwd).info,
    env: wantsEnv ? envInfo(cwd, home).info : null,
    contextWindow: wantsModels ? lookupContextWindow(modelsInfo(home).map, thread.model) : null,
    rateLimits: wantsRateFallback
      ? mergeRateLimits(cachedLimits, fallbackRateLimitsInfo(home, now).snaps ?? [])
      : cachedLimits,
    activity: wantsActivity ? transcripts.activity(id) : null,
    now,
  });
}

async function respond(method, params = {}) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "codex-hud", version: VERSION },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call":
      if (params.name !== TOOL.name) throw invalid("Unknown tool name");
      return { content: [{ type: "text", text: `codex-hud renders the Codex footer from ${URI}.` }] };
    case "resources/list":
      return { resources: [{ name: "footer", uri: URI, mimeType: "application/json" }] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read": {
      if (params.uri !== URI) throw invalid("Unknown resource URI");
      const state = (params._meta && params._meta[STATE_KEY]) || {};
      let tree;
      try {
        tree = await buildTree(state);
      } catch (e) {
        process.stderr.write(`codex-hud: render failed: ${e && e.stack}\n`);
        tree = "codex-hud: render error";
      }
      return { contents: [{ uri: URI, mimeType: "application/json", text: JSON.stringify(tree) }] };
    }
    default: {
      const e = new Error(`Method not found: ${method}`);
      e.code = -32601;
      throw e;
    }
  }
}

function invalid(message) {
  const e = new Error(message);
  e.code = -32602;
  return e;
}

function serve() {
  // Pre-warm local caches while Codex finishes the MCP initialize/tools/list handshake.
  const home = codexHome();
  loadConfig();
  modelsInfo(home);
  fallbackRateLimitsInfo(home);

  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  // Codex went away: nothing left to answer.
  process.stdout.on("error", (e) => process.exit(e && e.code === "EPIPE" ? 0 : 1));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inflight = new Set();
  rl.on("line", (line) => {
    const p = handle(line).finally(() => inflight.delete(p));
    inflight.add(p);
  });
  // Answer everything already received, then exit once stdout has flushed.
  rl.on("close", () =>
    Promise.allSettled([...inflight]).then(() => process.stdout.write("", () => process.exit(0))),
  );

  async function handle(line) {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (!req || typeof req !== "object" || typeof req.method !== "string") {
      return send({ jsonrpc: "2.0", id: req && req.id != null ? req.id : null, error: { code: -32600, message: "Invalid request" } });
    }
    if (!("id" in req)) return; // notification (e.g. notifications/initialized)
    try {
      send({ jsonrpc: "2.0", id: req.id, result: await respond(req.method, req.params || {}) });
    } catch (e) {
      send({ jsonrpc: "2.0", id: req.id, error: { code: e.code || -32603, message: e.message } });
    }
  }
}

export const SAMPLE_STATE = {
  app: { cli_version: "0.171.0", display_mode: "standard" },
  config: { statusline_items: [] },
  account: {
    rate_limits: [
      {
        limit_id: "codex",
        limit_name: null,
        primary_limit: { used_percent: 23, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 6720 },
        secondary_limit: { used_percent: 74, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 280000 },
      },
    ],
  },
  thread: {
    id: "00000000-0000-0000-0000-000000000000",
    name: null,
    agent: { state: "working" },
    model: { display_name: "gpt-5.5", provider: "openai", reasoning_level: "high" },
    workspace: { cwd: process.cwd() },
    permissions: { type: "managed", display_name: "workspace-write", file_system: { type: "restricted" }, network: "restricted" },
    approval: { policy: "on-request", reviewer: "user" },
    usage: {
      context: { context_window_size: 400000, used_tokens: 172000, used_percentage: 43 },
      total: { total_input_tokens: 245000, cache_read_input_tokens: 198000, cache_write_input_tokens: 0, other_input_tokens: 47000, output_tokens: 18400 },
    },
  },
};

async function preview(argv) {
  const i = argv.indexOf("--state");
  let state = SAMPLE_STATE;
  if (i >= 0) {
    const { readFileSync } = await import("node:fs");
    state = JSON.parse(readFileSync(argv[i + 1], "utf8"));
  }
  const tree = await buildTree(state);
  const t = argv.indexOf("--theme");
  console.log(toAnsi(tree, {}, t >= 0 ? argv[t + 1] : "dracula"));
  if (argv.includes("--json")) console.log(JSON.stringify(tree, null, 2));
  const lim = checkLimits(tree);
  console.error(`limits ${lim.ok ? "ok" : "EXCEEDED"}: ${lim.bytes} B json, ${lim.nodes} nodes, depth ${lim.depth}, ${lim.textBytes} B text`);
}

async function doctor(argv) {
  const { runDoctor, formatReport } = await import("./src/doctor.mjs");
  const report = await runDoctor({ buildTree, sampleState: SAMPLE_STATE, version: VERSION });
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report, { color: !!process.stdout.isTTY && !process.env.NO_COLOR }));
  return report.ok ? 0 : 1;
}

const argv = process.argv.slice(2);
if (argv.includes("--version")) console.log(VERSION);
else if (argv.includes("--preview")) preview(argv).then(() => process.exit(0));
else if (argv.includes("--doctor")) doctor(argv).then((code) => process.exit(code));
else serve();
