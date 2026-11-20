import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStatus } from "../src/git.mjs";
import { applyLine, emptyActivity, TranscriptWatcher } from "../src/transcript.mjs";
import { render, checkLimits, toAnsi, windowLabel, fmtDuration } from "../src/render.mjs";
import { DEFAULTS } from "../src/config.mjs";

const HUD = join(dirname(fileURLToPath(import.meta.url)), "..", "hud.mjs");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const state = (over = {}) => ({
  app: { cli_version: "0.171.0", display_mode: "standard" },
  config: { statusline_items: [] },
  account: {
    rate_limits: [
      {
        limit_id: "codex",
        limit_name: null,
        primary_limit: { used_percent: 95, window_minutes: 300, resets_at: 1000 + 3600 },
        secondary_limit: { used_percent: 10, window_minutes: 10080, resets_at: null },
      },
    ],
  },
  thread: {
    id: "t1",
    name: null,
    agent: { state: "ready" },
    model: { display_name: "gpt-5.5", provider: "openai", reasoning_level: "high" },
    workspace: { cwd: "/tmp/proj" },
    usage: { context: { context_window_size: 400000, used_tokens: 100000 } },
    ...over,
  },
});

test("git status parsing", () => {
  assert.deepEqual(parseStatus("## main...origin/main [ahead 2, behind 1]\n M a\n?? b\n"), {
    branch: "main", ahead: 2, behind: 1, dirty: 2, staged: 0, modified: 1, untracked: 1,
  });
  assert.deepEqual(parseStatus("## No commits yet on dev\n"), {
    branch: "dev", ahead: 0, behind: 0, dirty: 0, staged: 0, modified: 0, untracked: 0,
  });
  assert.equal(parseStatus("## HEAD (no branch)\n").branch, "detached");
  assert.equal(parseStatus("fatal"), null);
});

test("render: segments, colors and limits", () => {
  const tree = render(state(), {
    cfg: DEFAULTS,
    git: { branch: "main", ahead: 1, behind: 0, dirty: 3 },
    now: 1000 * 1000,
  });
  const line = strip(toAnsi(tree));
  assert.match(line, /gpt-5\.5 high/);
  assert.match(line, /proj │ ⎇ main\* ↑1/);
  assert.match(line, /Context ██░░░░░░ 25% 100k\/400k/);
  assert.match(line, /5h ████████ !! 95% ↻1h/);
  assert.match(line, /7d █░░░░░░░ 10%/);
  assert.doesNotMatch(line, /ready/);
  assert.ok(checkLimits(tree).ok);
  assert.ok(JSON.stringify(tree).includes('"color":"red"'));
});

test("render: null without a thread, segments are configurable", () => {
  assert.equal(render({}, { cfg: DEFAULTS }), null);
  const tree = render(state(), { cfg: { ...DEFAULTS, segments: ["model"] } });
  assert.equal(strip(toAnsi(tree)), "gpt-5.5 high");
});

test("helpers", () => {
  assert.equal(windowLabel(300), "5h");
  assert.equal(windowLabel(10080), "7d");
  assert.equal(fmtDuration(3 * 86400 + 5 * 3600), "3d5h");
  assert.equal(fmtDuration(59), "59s");
});

test("transcript: code-mode exec calls, plan and turn reset", () => {
  const a = emptyActivity();
  const line = (type, payload, ts = "2026-11-20T00:00:00Z") => JSON.stringify({ timestamp: ts, type, payload });
  applyLine(a, line("response_item", { type: "custom_tool_call", name: "exec", input: 'text(await tools.exec_command({cmd:"old"}));' }));
  applyLine(a, line("event_msg", { type: "task_started" }));
  assert.equal(a.tools.size, 0);
  applyLine(a, line("response_item", {
    type: "custom_tool_call",
    name: "exec",
    input: 'text(await tools.exec_command({cmd:"git status","max_output_tokens":1000}));\ntext(await tools.exec_command({cmd:"npm test"}));\nawait tools.apply_patch("*** Begin Patch");',
  }));
  applyLine(a, line("response_item", {
    type: "custom_tool_call",
    name: "exec",
    input: 'await tools.update_plan({plan:[{step:"a",status:"completed"},{step:"b",status:"in_progress"},{step:"c",status:"pending"}]});',
  }));
  applyLine(a, line("response_item", { type: "function_call", name: "wait", arguments: "{}" }));
  assert.equal(a.tools.get("exec_command"), 2);
  assert.equal(a.tools.get("apply_patch"), 1);
  assert.equal(a.tools.has("wait"), false);
  assert.equal(a.lastCommand, "npm test");
  assert.deepEqual(a.plan, { done: 1, total: 3, current: "b" });
  assert.equal(a.turnStartedAt, Date.parse("2026-11-20T00:00:00Z"));
});

test("transcript watcher: finds the rollout and reads appends incrementally", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-hud-"));
  const dir = join(home, "sessions", "2026", "11", "20");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-2026-11-20T00-00-00-abc.jsonl");
  const ev = (input) => JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input } });
  writeFileSync(file, `${ev('tools.exec_command({cmd:"ls"})')}\n`);
  const w = new TranscriptWatcher(home);
  assert.equal((await w.update("abc")).tools.get("exec_command"), 1);
  // Half a line (cut inside a multi-byte char) must wait for the rest.
  const next = Buffer.from(`${ev('tools.exec_command({cmd:"echo 你好"})')}\n`);
  appendFileSync(file, next.subarray(0, next.length - 8));
  assert.equal((await w.update("abc")).tools.get("exec_command"), 1);
  appendFileSync(file, next.subarray(next.length - 8));
  const a = await w.update("abc");
  assert.equal(a.tools.get("exec_command"), 2);
  assert.equal(a.lastCommand, "echo 你好");
});

function rpc(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [HUD], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    for (const m of messages) p.stdin.write(`${JSON.stringify(m)}\n`);
    p.stdin.end();
  });
}

test("mcp: handshake, entrypoint and resources/read", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-hud-"));
  const byId = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "ui://codex-hud/footer", _meta: { "com.openai/codex-statusline-state": state() } },
      },
      { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "ui://nope" } },
      { jsonrpc: "2.0", id: 5, method: "nope" },
    ],
    { CODEX_HOME: home, CODEX_HUD_CONFIG: join(home, "none.json") },
  ).then((rs) => new Map(rs.map((r) => [r.id, r])));
  const [init, list, read, bad, missing] = [1, 2, 3, 4, 5].map((id) => byId.get(id));
  assert.equal(init.result.serverInfo.name, "codex-hud");
  const tool = list.result.tools[0];
  assert.deepEqual(tool._meta["openai/ui"].entrypoints, [{ type: "statusline", resourceUri: "ui://codex-hud/footer" }]);
  const content = read.result.contents[0];
  assert.equal(content.mimeType, "application/json");
  const tree = JSON.parse(content.text);
  assert.equal(tree.type, "row");
  assert.ok(checkLimits(tree).ok);
  assert.equal(bad.error.code, -32602);
  assert.equal(missing.error.code, -32601);
});

test("mcp: CODEX_HUD_DISABLE clears the footer", async () => {
  const [read] = await rpc(
    [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://codex-hud/footer", _meta: { "com.openai/codex-statusline-state": state() } } }],
    { CODEX_HUD_DISABLE: "1" },
  );
  assert.equal(read.result.contents[0].text, "null");
});

test("installer: [tui] provider edit is section-aware and reversible", async () => {
  const { setProvider } = await import("../install.mjs");
  const base = 'model = "x"\n\n[tui]\ntheme = "d"\n\n[tui.nux]\na = 1\n';
  const on = setProvider(base, true);
  assert.match(on, /\[tui\]\nstatus_line_provider = \{ server = "codex-hud", tool = "statusline" \}\ntheme/);
  assert.equal(setProvider(on, true), on);
  assert.equal(setProvider(on, false), base);
  assert.match(setProvider('model = "x"\n', true), /\n\[tui\]\nstatus_line_provider/);
  const other = base.replace("[tui]\n", '[tui]\nstatus_line_provider = { server = "other", tool = "s" }\n');
  assert.equal(setProvider(other, false), other);
});
