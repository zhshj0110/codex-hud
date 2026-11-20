// Regression tests for the issues raised in the agy / codex reviews.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, sanitize } from "../src/config.mjs";
import { fallbackRateLimitsInfo } from "../src/env.mjs";
import { GIT_ARGS, gitInfo, parseStatus, _cacheSize } from "../src/git.mjs";
import { checkLimits, render, renderSafe, toAnsi } from "../src/render.mjs";
import { TranscriptWatcher } from "../src/transcript.mjs";
import { setProvider, UnsupportedConfig, PROVIDER_LINE } from "../install.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tmp = () => mkdtempSync(join(tmpdir(), "codex-hud-"));
const execLine = (cmd) =>
  `${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: `tools.exec_command({cmd:"${cmd}"})` } })}\n`;
const turnStart = () => `${JSON.stringify({ timestamp: "2026-11-20T00:00:00Z", type: "event_msg", payload: { type: "task_started" } })}\n`;

function rollout(home, id, day = "20") {
  const dir = join(home, "sessions", "2026", "11", day);
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-2026-11-${day}T00-00-00-${id}.jsonl`);
}

const baseState = (thread = {}, account = { rate_limits: [] }) => ({
  app: {},
  config: {},
  account,
  thread: {
    id: "t",
    agent: { state: "ready" },
    model: { display_name: "gpt", provider: "openai" },
    workspace: { cwd: "/tmp/p" },
    usage: { context: { used_percentage: 50 } },
    ...thread,
  },
});

// ---- config validation ----

test("config: bad types fall back to defaults, numbers are clamped", () => {
  assert.deepEqual(sanitize(null), { ...DEFAULTS });
  assert.deepEqual(sanitize({ segments: null }).segments, DEFAULTS.segments);
  assert.deepEqual(sanitize({ segments: "model" }).segments, DEFAULTS.segments);
  assert.deepEqual(sanitize({ segments: ["state", "nope", "state", "model"] }).segments, ["state", "model"]);
  assert.equal(sanitize({ barWidth: -1 }).barWidth, 1);
  assert.equal(sanitize({ barWidth: 6000 }).barWidth, 40);
  assert.equal(sanitize({ barWidth: "8" }).barWidth, DEFAULTS.barWidth);
  assert.equal(sanitize({ barWidth: Infinity }).barWidth, DEFAULTS.barWidth);
  assert.equal(sanitize({ lastCommandWidth: 0 }).lastCommandWidth, 4);
  assert.equal(sanitize({ icons: "yes" }).icons, false);
});

test("config: invalid config.json keeps the footer working", async () => {
  const dir = tmp();
  const cfgFile = join(dir, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ segments: null, barWidth: -5 }));
  const [read] = await rpc(
    [readReq(1, baseState())],
    { CODEX_HUD_CONFIG: cfgFile, CODEX_HOME: dir },
  );
  const tree = JSON.parse(read.result.contents[0].text);
  assert.match(strip(toAnsi(tree)), /gpt │ p │ Context █ 50%/);
});

// ---- UI limits at runtime ----

test("render: oversized inputs are clipped and stay within Codex limits", () => {
  const huge = "x".repeat(20000);
  const windows = Array.from({ length: 50 }, (_, i) => ({
    limit_id: `l${i}`,
    limit_name: huge,
    primary_limit: { used_percent: 10, window_minutes: 300, resets_at: null },
    secondary_limit: { used_percent: 20, window_minutes: 10080, resets_at: null },
  }));
  const state = baseState(
    { model: { display_name: huge, reasoning_level: huge }, workspace: { cwd: `/${huge}` }, agent: { state: huge } },
    { rate_limits: windows },
  );
  const activity = { tools: new Map([[huge, 3]]), lastCommand: huge, plan: null, turnStartedAt: null };
  const cfg = sanitize({ allLimits: true, barWidth: 6000, lastCommandWidth: 0 });
  const tree = render(state, { cfg, git: { branch: huge, ahead: 0, behind: 0, dirty: 0 }, activity, now: 0 });
  const lim = checkLimits(tree);
  assert.ok(lim.ok, JSON.stringify(lim));
  assert.ok(lim.textBytes < 2000);
  const line = strip(toAnsi(tree));
  assert.equal((line.match(/[57]d|5h/g) || []).length, 6, "rate-limit meters are capped");
  assert.match(line, /x{3}…/);
});

test("render: lastCommandWidth 0 from an unsanitized config still truncates", () => {
  const cmd = "y".repeat(500);
  const tree = render(baseState(), {
    cfg: { ...DEFAULTS, segments: ["tools"], lastCommandWidth: 0 },
    activity: { tools: new Map(), lastCommand: cmd, plan: null },
  });
  assert.equal(strip(toAnsi(tree)), "yyy…");
});

test("renderSafe: falls back to a minimal footer, then to null", () => {
  const state = baseState({}, {
    rate_limits: [{ limit_id: "codex", primary_limit: { used_percent: 1, window_minutes: 300 }, secondary_limit: null }],
  });
  const many = { ...DEFAULTS, segments: Array(200).fill("limits") };
  assert.equal(checkLimits(render(state, { cfg: many })).ok, false);
  const safe = renderSafe(state, { cfg: many });
  assert.ok(checkLimits(safe).ok);
  assert.equal(strip(toAnsi(safe)), "gpt │ Context ████░░░░ 50%");
});

test("render: malformed snapshot fields do not throw", () => {
  for (const thread of ["x", null, 1]) {
    assert.equal(render({ thread }, { cfg: DEFAULTS }), null);
  }
  const tree = render(baseState({ usage: { context: { used_percentage: "50" } }, model: null, agent: 5 }), { cfg: DEFAULTS });
  assert.ok(checkLimits(tree).ok);
});

// ---- transcript tailing ----

test("transcript: short reads advance by bytesRead and lose nothing", async () => {
  const home = tmp();
  const file = rollout(home, "short");
  writeFileSync(file, execLine("one") + execLine("two"));
  // A handle whose reads return at most 10 bytes.
  const shortOpen = async (p, flags) => {
    const fh = await open(p, flags);
    return {
      stat: () => fh.stat(),
      close: () => fh.close(),
      read: (buf, off, len, pos) => fh.read(buf, off, Math.min(len, 10), pos),
    };
  };
  const w = new TranscriptWatcher(home, { open: shortOpen });
  let a;
  for (let i = 0; i < 100; i++) a = await w.update("short");
  assert.equal(a.tools.get("exec_command"), 2);
  assert.equal(a.lastCommand, "two");
  assert.equal(w.threads.get("short").rest.length, 0);
});

test("transcript: remainder is copied, not a view of the read buffer", async () => {
  const home = tmp();
  const file = rollout(home, "mem");
  writeFileSync(file, execLine("a").repeat(20000) + '{"partial":');
  let readBuffer;
  const captureOpen = async (p, flags) => {
    const fh = await open(p, flags);
    return {
      stat: () => fh.stat(),
      close: () => fh.close(),
      read: (buf, ...args) => {
        readBuffer = buf.buffer;
        return fh.read(buf, ...args);
      },
    };
  };
  const w = new TranscriptWatcher(home, { open: captureOpen });
  await w.update("mem");
  const rest = w.threads.get("mem").rest;
  assert.equal(rest.toString(), '{"partial":');
  assert.notEqual(rest.buffer, readBuffer);
});

test("transcript: non-object JSON does not discard later records in the same batch", async (t) => {
  const home = tmp();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(rollout(home, "t"), turnStart() + "null\n[]\n123\n" + turnStart());
  const activity = await new TranscriptWatcher(home).update("t");
  assert.equal(activity.turns, 2);
});

test("transcript: oversized records are dropped, later ones still parse", async () => {
  const home = tmp();
  const file = rollout(home, "long");
  writeFileSync(file, `${"z".repeat(5000)}`);
  const w = new TranscriptWatcher(home, { maxLine: 1000 });
  await w.update("long");
  assert.equal(w.threads.get("long").rest.length, 0);
  appendFileSync(file, `${"z".repeat(5000)}\n${execLine("after")}`);
  const a = await w.update("long");
  assert.equal(a.lastCommand, "after");
  assert.equal(a.tools.get("exec_command"), 1);
});

test("transcript: byte limit applies to complete and split records", async (t) => {
  const home = tmp();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = rollout(home, "line-limit");
  const exact = execLine("🚀".repeat(30));
  const large = execLine("🚀".repeat(31));
  const maxLine = Buffer.byteLength(exact) - 1;
  const w = new TranscriptWatcher(home, { maxLine });
  writeFileSync(file, Buffer.concat([Buffer.from(large + exact), Buffer.from(large).subarray(0, maxLine)]));
  const activity = await w.update("line-limit");
  assert.equal(activity.tools.get("exec_command"), 1);
  assert.equal(activity.lastCommand, "🚀".repeat(30));

  appendFileSync(file, Buffer.from(large).subarray(maxLine));
  appendFileSync(file, execLine("after"));
  await w.update("line-limit");
  assert.equal(activity.tools.get("exec_command"), 2);
  assert.equal(activity.lastCommand, "after");
});

test("transcript: first attach to a large file reads only the tail; backlog is chunked", async () => {
  const home = tmp();
  const file = rollout(home, "big");
  // No turn boundary: if the whole file were parsed, all 5002 calls would be counted.
  writeFileSync(file, execLine("old").repeat(5000) + execLine("new1") + execLine("new2"));
  const w = new TranscriptWatcher(home, { initialTail: 500 });
  const a = await w.update("big");
  assert.ok(a.tools.get("exec_command") < 10, `parsed ${a.tools.get("exec_command")} calls, expected only the tail`);
  assert.equal(a.lastCommand, "new2");

  const file2 = rollout(home, "chunked");
  writeFileSync(file2, execLine("c").repeat(10));
  const w2 = new TranscriptWatcher(home, { maxRead: 100 });
  const reads = [];
  for (let i = 0; i < 20; i++) reads.push((await w2.update("chunked")).tools.get("exec_command") || 0);
  assert.ok(reads[0] < 10, "a single poll does not consume the whole backlog");
  assert.equal(reads.at(-1), 10);
});

test("transcript: deleted, moved and replaced rollouts are picked up again", async () => {
  const home = tmp();
  const file = rollout(home, "rot");
  const planLine = `${JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: '{"plan":[{"step":"s","status":"pending"}]}' } })}\n`;
  writeFileSync(file, planLine + execLine("first"));
  const w = new TranscriptWatcher(home);
  assert.equal((await w.update("rot")).lastCommand, "first");
  assert.ok(w.activity("rot").plan);

  // Replaced in place by a different, larger file (new inode, same path, no plan).
  const repl = `${file}.new`;
  writeFileSync(repl, execLine("second-a").repeat(20) + execLine("second-b"));
  renameSync(repl, file);
  let a = await w.update("rot");
  assert.equal(a.lastCommand, "second-b");
  assert.equal(a.plan, null, "state from the replaced file is dropped");
  assert.equal(a.tools.get("exec_command"), 21);

  // Moved to another day directory.
  const moved = rollout(home, "rot", "21");
  renameSync(file, moved);
  await w.update("rot"); // notices ENOENT
  appendFileSync(moved, execLine("third"));
  a = await w.update("rot");
  assert.equal(a.lastCommand, "third");

  // Deleted for good: state resets instead of freezing.
  unlinkSync(moved);
  a = await w.update("rot");
  assert.equal(a.tools.size, 0);
});

test("transcript: thread map is bounded (LRU)", async () => {
  const home = tmp();
  const w = new TranscriptWatcher(home, { maxThreads: 2 });
  for (const id of ["a", "b", "a", "c"]) await w.update(id);
  assert.deepEqual([...w.threads.keys()], ["a", "c"]);
});

// ---- git ----

test("git: untracked files count even with status.showUntrackedFiles=no", async () => {
  assert.ok(GIT_ARGS.includes("--untracked-files=normal"));
  const repo = tmp();
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "status.showUntrackedFiles", "no"]);
  writeFileSync(join(repo, "new.txt"), "x");
  const info = await gitInfo(repo).refresh;
  assert.equal(info.dirty, 1);
});

test("git: CRLF output and bounded cache", async () => {
  assert.deepEqual(parseStatus("## main...origin/main [ahead 1]\r\n M a\r\n"), {
    branch: "main", ahead: 1, behind: 0, dirty: 1, staged: 0, modified: 1, untracked: 0,
  });
  const base = tmp();
  for (let i = 0; i < 40; i++) gitInfo(join(base, `missing-${i}`));
  assert.ok(_cacheSize() <= 16);
});

// ---- installer TOML edits ----

const on = (t) => setProvider(t, true);
const off = (t) => setProvider(t, false);

test("installer: equivalent [tui] spellings are found, not duplicated", () => {
  for (const header of ['[ tui ]', '["tui"]', "['tui']", "[tui] # ui", String.raw`["t\u0075i"]`]) {
    const toml = `a = 1\n\n${header}\ntheme = "d"\n`;
    const out = on(toml);
    assert.equal(out.match(/^\s*\[/gm).length, 1, header);
    assert.ok(out.includes(`${header}\n${PROVIDER_LINE}\ntheme`), header);
    assert.equal(off(out), toml);
  }
});

test("installer: refuses layouts it cannot edit safely", () => {
  const bad = [
    '[tui.status_line_provider]\nserver = "x"\ntool = "y"\n',
    'tui.theme = "dark"\n',
    '"tui".theme = "dark"\n[other]\n',
    String.raw`"t\U00000075i".theme = "dark"` + "\n",
    '[tui]\nstatus_line_provider.server = "x"\n',
    '[tui]\nstatus_line_provider = {\n  server = "x" }\n',
    "[tui]\na = 1\n[tui]\nb = 2\n",
  ];
  for (const toml of bad) assert.throws(() => on(toml), UnsupportedConfig, toml);
});

test("installer: multi-line arrays and strings do not confuse the section scan", () => {
  const toml = [
    "[tui]",
    "matrix = [",
    "[1, 2],",
    "[3, 4],",
    "]",
    'notes = """',
    "status_line_provider = not a key",
    "[not a header]",
    '"""',
    'lit = \'\'\'',
    "[also not a header]",
    "'''",
    'hash = "a # not a comment [x]"',
    "",
    "[next]",
    "k = 1",
    "",
  ].join("\n");
  const out = on(toml);
  assert.ok(out.startsWith(`[tui]\n${PROVIDER_LINE}\nmatrix = [`));
  assert.ok(out.includes("status_line_provider = not a key"));
  assert.equal(out.split(PROVIDER_LINE).length, 2);
  assert.equal(off(out), toml);
  // Re-running replaces the existing line instead of adding another.
  assert.equal(on(out), out);
});

test("installer: uninstall removes only the codex-hud provider", () => {
  const other = '[tui]\nstatus_line_provider = { server = "other", tool = "s" } # was "codex-hud"\n';
  assert.equal(off(other), other);
  const single = "[tui]\nstatus_line_provider = { server = 'codex-hud', tool = 'statusline' }\nx = 1\n";
  assert.equal(off(single), "[tui]\nx = 1\n");
  for (const field of [
    '"server" = "codex-hud"',
    "'server' = 'codex-hud'",
    String.raw`"s\u0065rver" = "codex-\u0068ud"`,
  ]) {
    const config = `[tui]\nstatus_line_provider = { tool = "statusline", ${field} }\n`;
    assert.equal(off(config), "[tui]\n");
  }
  const toolText = String.raw`[tui]
status_line_provider = { tool = "server = \"codex-hud\"", server = "other" }
`;
  assert.equal(off(toolText), toolText);
});

test("installer: CRLF files keep CRLF", () => {
  const out = on("[tui]\r\ntheme = \"d\"\r\n");
  assert.equal(out, `[tui]\r\n${PROVIDER_LINE}\r\ntheme = "d"\r\n`);
  assert.equal(on("a = 1\r\n"), `a = 1\r\n\r\n[tui]\r\n${PROVIDER_LINE}\r\n`);
});

// ---- installer end to end with a fake `codex` ----

function fakeCodex() {
  const bin = tmp();
  const script = join(bin, "codex");
  writeFileSync(
    script,
    `#!/bin/sh
cfg="$CODEX_HOME/config.toml"
case "$1 $2" in
  "features list")
    if [ -n "$FAKE_REJECT" ] && grep -q status_line_provider "$cfg" 2>/dev/null; then echo "bad config" >&2; exit 1; fi
    echo "tui_extensions_statusline  experimental  false" ;;
  "features enable") printf '\\n# feature enabled\\n' >> "$cfg" ;;
  "mcp get") exit 1 ;;
  "mcp add")
    if [ -n "$FAKE_ADD_FAIL" ]; then echo "could not add server" >&2; exit 1; fi
    printf '\\n[mcp_servers.codex-hud]\\ncommand = "node"\\n' >> "$cfg"
    if [ -n "$FAKE_ARGS_FILE" ]; then printf '%s\\n' "$@" > "$FAKE_ARGS_FILE"; fi ;;
  "mcp remove")
    if [ -n "$FAKE_REMOVE_FAIL" ]; then echo "could not remove server" >&2; exit 1; fi ;;
esac
exit 0
`,
  );
  chmodSync(script, 0o755);
  return bin;
}

function install(home, bin, extraEnv = {}, args = []) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "install.mjs"), ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

test("installer e2e: atomic write keeps permissions; rejected config is rolled back", () => {
  const bin = fakeCodex();
  const home = tmp();
  const cfg = join(home, "config.toml");
  const original = 'model = "x"\n\n[tui]\ntheme = "d"\n';
  writeFileSync(cfg, original, { mode: 0o600 });

  const inodeBefore = statSync(cfg).ino;
  let r = install(home, bin);
  assert.equal(r.code, 0, r.out);
  // Written via temp file + rename (new inode), with no temp file left behind.
  assert.notEqual(statSync(cfg).ino, inodeBefore);
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith(".tmp")), []);
  assert.match(readFileSync(cfg, "utf8"), /\[tui\]\nstatus_line_provider = \{ server = "codex-hud"/);
  assert.equal(statSync(cfg).mode & 0o777, 0o600);

  r = install(home, bin, {}, ["--uninstall"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(readFileSync(cfg, "utf8"), /status_line_provider/);

  writeFileSync(cfg, original);
  r = install(home, bin, { FAKE_REJECT: "1" });
  assert.equal(r.code, 1);
  assert.match(r.out, /Restored/);
  assert.equal(readFileSync(cfg, "utf8"), original);
});

test("installer e2e: uninstall delegates removal of a root inline server", (t) => {
  const bin = fakeCodex();
  const home = tmp();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });
  writeFileSync(join(home, "config.toml"), 'mcp_servers = { "codex-hud" = { command = "node" }, other = { command = "git" } }\n');
  const result = install(home, bin, {}, ["--uninstall"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /\$ codex mcp remove codex-hud/);
});

test("installer e2e: failed commands restore existing or absent config", (t) => {
  const bin = fakeCodex();
  const home = tmp();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });
  const cfg = join(home, "config.toml");
  const original = `[tui]\n${PROVIDER_LINE}\n[mcp_servers.codex-hud]\ncommand = "old-node"\n`;
  writeFileSync(cfg, original, { mode: 0o640 });
  const update = install(home, bin, { FAKE_ADD_FAIL: "1" });
  assert.equal(update.code, 1, update.out);
  assert.doesNotMatch(update.out, /mcp remove/);
  assert.match(update.out, /Restored/);
  assert.equal(readFileSync(cfg, "utf8"), original);
  assert.equal(statSync(cfg).mode & 0o777, 0o640);

  const uninstall = install(home, bin, { FAKE_REMOVE_FAIL: "1" }, ["--uninstall"]);
  assert.equal(uninstall.code, 1, uninstall.out);
  assert.equal(readFileSync(cfg, "utf8"), original);

  unlinkSync(cfg);
  const fresh = install(home, bin, { FAKE_ADD_FAIL: "1" });
  assert.equal(fresh.code, 1, fresh.out);
  assert.ok(!readdirSync(home).includes("config.toml"));
});

test("installer e2e: passes HUD environment overrides to the MCP registration", (t) => {
  const bin = fakeCodex();
  const home = tmp();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });
  const argsFile = join(home, "args");
  const env = {
    CODEX_HUD_CONFIG: join(home, "custom settings.json"),
    XDG_CONFIG_HOME: join(home, "xdg"),
    CODEX_HUD_DISABLE: "1",
  };
  const result = install(home, bin, { ...env, FAKE_ARGS_FILE: argsFile }, ["--no-select"]);
  assert.equal(result.code, 0, result.out);
  const args = readFileSync(argsFile, "utf8").split("\n");
  for (const [key, value] of Object.entries(env)) {
    const index = args.indexOf(`${key}=${value}`);
    assert.ok(index > 0, key);
    assert.equal(args[index - 1], "--env");
  }
});

test("installer e2e: unsupported layout aborts before any change", () => {
  const bin = fakeCodex();
  const home = tmp();
  const cfg = join(home, "config.toml");
  const original = 'tui.theme = "dark"\n';
  writeFileSync(cfg, original);
  const r = install(home, bin);
  assert.equal(r.code, 1);
  assert.match(r.out, /--no-select/);
  assert.equal(readFileSync(cfg, "utf8"), original);
  rmSync(home, { recursive: true });
});

// ---- server lifecycle ----

function readReq(id, state) {
  return { jsonrpc: "2.0", id, method: "resources/read", params: { uri: "ui://codex-hud/footer", _meta: { "com.openai/codex-statusline-state": state } } };
}

function rateEvent(at, primary, secondary = null) {
  return JSON.stringify({
    timestamp: new Date(at).toISOString(),
    type: "event_msg",
    payload: { type: "token_count", rate_limits: { limit_id: "codex", primary, secondary } },
  }) + "\n";
}

test("limits: fallback expiration uses the original log event time", async (t) => {
  const home = tmp();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = Date.now();
  const window = { used_percent: 50, window_minutes: 300 };
  const file = rollout(home, "t");
  writeFileSync(file, rateEvent(now - 301_000, window));
  assert.equal(await fallbackRateLimitsInfo(home, now).refresh, null);

  appendFileSync(file, rateEvent(now, window));
  assert.equal((await fallbackRateLimitsInfo(home, now + 30_000).refresh)[0].primary_limit.used_percent, 50);
  assert.equal(await fallbackRateLimitsInfo(home, now + 300_000).refresh, null);
});

test("server: an expired cached window is replaced from the rollout while a valid window is retained", async (t) => {
  const home = tmp();
  const config = join(home, "hud.json");
  writeFileSync(config, '{"segments":["limits"]}');
  const child = spawn(process.execPath, [join(ROOT, "hud.mjs")], {
    env: { ...process.env, CODEX_HOME: home, CODEX_HUD_CONFIG: config, CODEX_HUD_DISABLE: "" },
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => {
    lines.close();
    child.kill();
    rmSync(home, { recursive: true, force: true });
  });
  const replies = lines[Symbol.asyncIterator]();
  const read = async (id, rate_limits) => {
    child.stdin.write(JSON.stringify(readReq(id, baseState({}, { rate_limits }))) + "\n");
    const { value } = await replies.next();
    return JSON.parse(value).result.contents[0].text;
  };
  const now = Math.floor(Date.now() / 1000);
  assert.match(await read(1, [{
    limit_id: "codex",
    primary_limit: { used_percent: 50, window_minutes: 300, resets_at: now - 1 },
    secondary_limit: { used_percent: 73, window_minutes: 10080, resets_at: now + 3600 },
  }]), /50%/);
  writeFileSync(rollout(home, "t"), rateEvent(now * 1000, {
    used_percent: 12, window_minutes: 300, resets_at: now + 1800,
  }, { used_percent: 66, window_minutes: 10080, resets_at: now + 3600 }));

  const footer = await read(2, []);
  assert.doesNotMatch(footer, /50%|66%/);
  assert.match(footer, /12%/);
  assert.match(footer, /73%/);
});

function rpc(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, "hud.mjs")], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => resolve(Object.assign(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)), { code })));
    for (const m of messages) p.stdin.write(`${JSON.stringify(m)}\n`);
    p.stdin.end();
  });
}

test("server: every request sent before EOF is answered, then it exits 0", async () => {
  const home = tmp();
  const big = baseState({ name: "n".repeat(2000) });
  const replies = await rpc(
    Array.from({ length: 200 }, (_, i) => readReq(i, big)),
    { CODEX_HOME: home, CODEX_HUD_CONFIG: join(home, "none.json") },
  );
  assert.equal(replies.code, 0);
  assert.deepEqual(replies.map((r) => r.id).sort((a, b) => a - b), Array.from({ length: 200 }, (_, i) => i));
});

test("server: closed stdout (EPIPE) exits cleanly", async () => {
  const p = spawn(process.execPath, [join(ROOT, "hud.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  p.stderr.on("data", (d) => (stderr += d));
  p.stdout.destroy();
  const code = await new Promise((resolve) => {
    p.on("close", resolve);
    for (let i = 0; i < 50; i++) p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" })}\n`);
    p.stdin.end();
  });
  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /Error|EPIPE/);
});
