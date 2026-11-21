// Unit tests for doctor diagnostics, plan.current, thread.name title segment,
// running vs completed tool state, install command, and open-source companion files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, SEGMENTS, configSource, sanitize } from "../src/config.mjs";
import { collectEnv, collectLatestRateLimits, countMcpServers } from "../src/env.mjs";
import { parseStatus } from "../src/git.mjs";
import { GROUP_GAP, checkLimits, clip, oneLine, render, toAnsi } from "../src/render.mjs";
import { applyLine, emptyActivity, runningCounts } from "../src/transcript.mjs";
import { HUD, MANAGED_NODE, PROVIDER_LINE, launchCommand, readProvider } from "../install.mjs";
import { formatReport, runDoctor } from "../src/doctor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tmp = () => mkdtempSync(join(tmpdir(), "codex-hud-feat-"));

const baseState = (thread = {}) => ({
  app: { cli_version: "0.171.0" },
  config: {},
  account: { rate_limits: [] },
  thread: {
    id: "t1",
    name: null,
    agent: { state: "working" },
    model: { display_name: "gpt-5.5", provider: "openai" },
    workspace: { cwd: "/tmp/proj" },
    usage: { context: { used_percentage: 40 } },
    ...thread,
  },
});

// ---- 1. plan.current & title segment & running vs completed tools ----

test("render: plan.current step is displayed, cleaned, truncated and toggleable", () => {
  const activity = {
    ...emptyActivity(),
    plan: { done: 1, total: 3, current: "Step 2:\nfix\t\u0007 everything\u202e now" },
  };
  const cfg = { ...DEFAULTS, segments: ["tools"], planCurrentWidth: 16 };
  const tree = render(baseState(), { cfg, activity });
  const line = strip(toAnsi(tree));
  assert.equal(line, "☑ 1/3 Step 2: fix eve…");
  assert.ok(checkLimits(tree).ok);

  const hidden = render(baseState(), { cfg: { ...cfg, showPlanCurrent: false }, activity });
  assert.equal(strip(toAnsi(hidden)), "☑ 1/3");
});

test("render: optional title segment cleans control/bidi chars and respects titleWidth", () => {
  assert.ok(SEGMENTS.includes("title"));
  assert.ok(!DEFAULTS.segments.includes("title"), "title is opt-in so default layout is unchanged");

  const cfg = sanitize({ segments: ["model", "title", "context"], titleWidth: 18 });
  assert.deepEqual(cfg.segments, ["model", "title", "context"]);
  assert.equal(cfg.titleWidth, 18);

  const withName = render(
    baseState({ name: "  Refactor\n\tstatusline\u202e provider  " }),
    { cfg },
  );
  assert.equal(strip(toAnsi(withName)), "gpt-5.5 │ Refactor statusli… │ Context ███░░░░░ 40%");
  assert.ok(checkLimits(withName).ok);

  // Blank or null thread.name omits the title segment cleanly.
  const blank = render(baseState({ name: " \n\t\r " }), { cfg });
  assert.equal(strip(toAnsi(blank)), "gpt-5.5 │ Context ███░░░░░ 40%");
});

test("clip & oneLine: surrogate pairs are never split into lone surrogates", () => {
  const emoji = "🚀".repeat(10);
  const clipped = clip(emoji, 5);
  assert.equal(clipped, "🚀🚀🚀🚀…");
  assert.equal(oneLine("a\r\nb\u0007\u202ec"), "a b c");
});

test("transcript & render: tracks running (◐) vs completed (⚙) tools across call types", () => {
  const a = emptyActivity();
  const ev = (type, payload, ts = "2026-11-20T00:00:00Z") => JSON.stringify({ timestamp: ts, type, payload });

  applyLine(a, ev("event_msg", { type: "task_started" }));

  // 1. Standard function_call -> running until function_call_output arrives.
  applyLine(a, ev("response_item", {
    type: "function_call",
    call_id: "c1",
    name: "exec_command",
    arguments: '{"cmd":"npm test"}',
  }));
  // 2. Code-mode exec calling two tools -> both running.
  applyLine(a, ev("response_item", {
    type: "custom_tool_call",
    call_id: "c2",
    name: "exec",
    input: 'text(await tools.exec_command({cmd:"git diff"}));\nawait tools.apply_patch("***");',
  }));
  // 3. local_shell_call -> running as "shell".
  applyLine(a, ev("response_item", {
    type: "local_shell_call",
    call_id: "c3",
    action: { command: ["ls", "-la"] },
  }));

  assert.deepEqual(Object.fromEntries(runningCounts(a)), {
    exec_command: 2,
    apply_patch: 1,
    shell: 1,
  });

  // Render while c1, c2, c3 are all in flight: all tools appear under ◐, none under ⚙.
  const cfg = { ...DEFAULTS, segments: ["tools"], showLastCommand: false };
  let line = strip(toAnsi(render(baseState(), { cfg, activity: a })));
  assert.equal(line, "◐ exec_command×2 apply_patch shell");

  // c1 finishes -> 1 exec_command is now completed (⚙), 1 is still running (◐).
  applyLine(a, ev("response_item", {
    type: "function_call_output",
    call_id: "c1",
    output: "ok",
  }));
  line = strip(toAnsi(render(baseState(), { cfg, activity: a })));
  assert.equal(line, "◐ exec_command apply_patch shell ⚙ exec_command");

  // c2 yields a background code-mode cell ("Script running with cell ID g4:10") -> stays running!
  applyLine(a, ev("response_item", {
    type: "custom_tool_call_output",
    call_id: "c2",
    output: [{ type: "input_text", text: "Script running with cell ID g4:10\nWall time 1.0 seconds" }],
  }));
  assert.equal(runningCounts(a).get("apply_patch"), 1);

  // A `wait` call on cell g4:10 that still yields keeps it running.
  applyLine(a, ev("response_item", {
    type: "function_call",
    call_id: "w1",
    name: "wait",
    arguments: '{"cell_id":"g4:10"}',
  }));
  applyLine(a, ev("response_item", {
    type: "function_call_output",
    call_id: "w1",
    output: [{ type: "input_text", text: "Script running with cell ID g4:10\n" }],
  }));
  assert.equal(runningCounts(a).get("apply_patch"), 1);

  // Next `wait` completes the cell -> c2's tools move from running to completed.
  applyLine(a, ev("response_item", {
    type: "function_call",
    call_id: "w2",
    name: "wait",
    arguments: '{"cell_id":"g4:10"}',
  }));
  applyLine(a, ev("response_item", {
    type: "function_call_output",
    call_id: "w2",
    output: [{ type: "input_text", text: "Script completed\nWall time 0.4 seconds\n" }],
  }));
  assert.equal(runningCounts(a).has("apply_patch"), false);
  assert.equal(runningCounts(a).has("exec_command"), false);
  line = strip(toAnsi(render(baseState(), { cfg, activity: a })));
  assert.equal(line, "◐ shell ⚙ exec_command×2 apply_patch");

  // task_complete clears any remaining in-flight calls (c3).
  applyLine(a, ev("event_msg", { type: "task_complete" }));
  assert.equal(runningCounts(a).size, 0);
  line = strip(toAnsi(render(baseState(), { cfg, activity: a })));
  assert.equal(line, "⚙ exec_command×2 apply_patch shell");

  // Next task_started resets both running and completed counts.
  applyLine(a, ev("event_msg", { type: "task_started" }));
  assert.equal(a.tools.size, 0);
  assert.equal(a.running.size, 0);
});

// ---- 2. install.mjs ----

test("install: launchCommand registers the running node with hud.mjs", () => {
  assert.deepEqual(launchCommand(), [process.execPath, HUD]);
  assert.deepEqual(launchCommand({ execPath: "/custom/node" }), ["/custom/node", HUD]);
});

test("install: MANAGED_NODE spots version-manager paths only", () => {
  for (const p of ["/Users/a/.nvm/versions/node/v22.0.0/bin/node", "/Users/a/.volta/bin/node", "/home/a/.local/share/fnm/node-versions/v22/installation/bin/node", "/home/a/.local/share/mise/installs/node/22/bin/node"]) {
    assert.ok(MANAGED_NODE.test(p), p);
  }
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "node"]) assert.ok(!MANAGED_NODE.test(p), p);
});

// ---- 3. Doctor diagnostics ----

test("doctor: reports healthy setup, warnings, failures and JSON output", async () => {
  const home = tmp();
  const cfgPath = join(home, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ barWidth: 10, unknownKey: 1, icons: "bad" }));
  writeFileSync(join(home, "config.toml"), `[tui]\n${PROVIDER_LINE}\n`);

  const fakeRun = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    if (key === "codex --version") return { ok: true, stdout: "codex-cli 0.171.0\n", stderr: "" };
    if (key === "codex features list") {
      return { ok: true, stdout: "tui_extensions_statusline  experimental  true\n", stderr: "" };
    }
    if (key === "codex mcp get codex-hud --json") {
      return {
        ok: true,
        stdout: JSON.stringify({
          name: "codex-hud",
          enabled: true,
          transport: { command: "node", args: [HUD], env: { CODEX_HOME: home } },
        }),
        stderr: "",
      };
    }
    return { ok: false, stdout: "", stderr: "unexpected" };
  };

  // Make a fake `codex` on PATH so `which("codex")` succeeds even on machines without codex.
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeCodex, 0o755);

  const report = await runDoctor({
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home, CODEX_HUD_CONFIG: cfgPath },
    run: fakeRun,
    buildTree: async () => render(baseState(), { cfg: DEFAULTS }),
    sampleState: baseState(),
    version: "0.1.0",
  });

  assert.equal(report.ok, true);
  assert.equal(report.counts.fail, 0);
  // Config has unknownKey and bad icons type -> 1 warning.
  const cfgCheck = report.checks.find((c) => c.id === "config");
  assert.equal(cfgCheck.status, "warn");
  assert.deepEqual(cfgCheck.details.unknown, ["unknownKey"]);
  assert.deepEqual(cfgCheck.details.ignored, ["icons"]);
  assert.equal(cfgCheck.details.effective.barWidth, 10);

  const mcpCheck = report.checks.find((c) => c.id === "mcp");
  assert.equal(mcpCheck.status, "ok", mcpCheck.summary);
  assert.equal(report.checks.find((c) => c.id === "launcher"), undefined, "no launcher check without bin/");

  const text = formatReport(report, { color: false });
  assert.match(text, /codex-hud doctor v0\.1\.0/);
  assert.match(text, /Nerd Font probe/);
  assert.match(text, /Effective config:/);

  // A version-manager node triggers a warning about removing that version.
  const directReport = await runDoctor({
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home, CODEX_HUD_CONFIG: join(home, "missing.json") },
    run: (cmd, args) => {
      if (args[0] === "mcp") {
        return {
          ok: true,
          stdout: JSON.stringify({
            name: "codex-hud",
            enabled: true,
            transport: { command: "/Users/test/.nvm/versions/node/v22.0.0/bin/node", args: [HUD] },
          }),
          stderr: "",
        };
      }
      return fakeRun(cmd, args);
    },
    nodeVersion: "16.19.0",
  });
  assert.equal(directReport.ok, false, "Node < 18 fails the doctor check");
  assert.equal(directReport.checks.find((c) => c.id === "node").status, "fail");
  assert.equal(directReport.checks.find((c) => c.id === "mcp").status, "warn");
  assert.match(directReport.checks.find((c) => c.id === "mcp").summary, /version-manager node/);
});

test("doctor CLI: --doctor and --doctor --json run cleanly", () => {
  const home = tmp();
  const out = execFileSync(process.execPath, [HUD, "--doctor", "--json"], {
    env: { ...process.env, CODEX_HOME: home, CODEX_HUD_CONFIG: join(home, "none.json") },
    encoding: "utf8",
  });
  const report = JSON.parse(out);
  assert.equal(typeof report.ok, "boolean");
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.icons.plain && report.icons.nerd);
  assert.ok(report.preview.limits.ok);
});

// ---- 4. Open-source companion files & configSource ----

test("companion files: config.example.json matches DEFAULTS and docs are non-empty", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config.example.json"), "utf8"));
  assert.deepEqual(example, { ...DEFAULTS, segments: [...DEFAULTS.segments] });
  for (const file of ["README.md", "README_CN.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", ".github/workflows/ci.yml"]) {
    const content = readFileSync(join(ROOT, file), "utf8").trim();
    assert.ok(content.length > 100, `${file} should be populated`);
  }
  assert.deepEqual(configSource({ CODEX_HUD_CONFIG: "/a/b.json" }), { path: "/a/b.json", from: "CODEX_HUD_CONFIG" });
  assert.deepEqual(configSource({ XDG_CONFIG_HOME: "/xdg" }), { path: join("/xdg", "codex-hud", "config.json"), from: "XDG_CONFIG_HOME" });
  assert.equal(readProvider(`[tui]\n${PROVIDER_LINE} # comment\n`), PROVIDER_LINE);
});

// ---- 5. Expanded HUD segments (mode, tokens, git counts, env, session, provider) ----

test("render: mode segment shows permissions, approval, profile and raw mode", () => {
  const cfg = { ...DEFAULTS, segments: ["model", "mode"] };
  const s = {
    ...baseState({
      model: { display_name: "gpt-5.5", provider: "azure", reasoning_level: "high" },
      permissions: { type: "managed", display_name: "workspace-write", file_system: { type: "restricted" }, network: "restricted" },
      approval: { policy: "on-request", reviewer: "auto-review" },
    }),
    app: { cli_version: "0.171.0", display_mode: "raw" },
    config: { statusline_items: [], profile: "work" },
  };
  const tree = render(s, { cfg });
  assert.equal(strip(toAnsi(tree)), "gpt-5.5 high azure │ ◈ workspace-write·auto-review @work raw");
  assert.ok(checkLimits(tree).ok);

  // Deduplicates when display_name already contains the approval policy.
  const dedup = render(
    baseState({
      permissions: { type: "disabled", display_name: "full-access" },
      approval: { policy: "never", reviewer: "user" },
    }),
    { cfg: { ...DEFAULTS, segments: ["mode"] } },
  );
  assert.equal(strip(toAnsi(dedup)), "◈ full-access·never");
});

test("render: tokens segment shows input/output totals and toggleable cache hit rate", () => {
  const s = baseState({
    usage: {
      context: { used_percentage: 40 },
      total: {
        total_input_tokens: 200_000,
        cache_read_input_tokens: 164_000,
        cache_write_input_tokens: 0,
        other_input_tokens: 36_000,
        output_tokens: 15_200,
      },
    },
  });
  const cfg = { ...DEFAULTS, segments: ["tokens"] };
  assert.equal(strip(toAnsi(render(s, { cfg }))), "↑200k ↓15k cache 82%");
  assert.equal(strip(toAnsi(render(s, { cfg: { ...cfg, showCacheRate: false } }))), "↑200k ↓15k");
});

test("git & render: parses and renders staged/modified/untracked counts", () => {
  const g = parseStatus("## feat/hud...origin/feat/hud [ahead 1]\nA  staged.js\nMM both.js\n M mod.js\n?? new.txt\n");
  assert.deepEqual(g, {
    branch: "feat/hud",
    ahead: 1,
    behind: 0,
    dirty: 4,
    staged: 2,
    modified: 2,
    untracked: 1,
  });
  const cfg = { ...DEFAULTS, segments: ["project"] };
  assert.equal(strip(toAnsi(render(baseState(), { cfg, git: g }))), "proj │ ⎇ feat/hud* +2~2?1 ↑1");
  assert.equal(strip(toAnsi(render(baseState(), { cfg: { ...cfg, segments: ["model", "project"], icons: true }, git: g }))), "\uee9c gpt-5.5 │  proj │  feat/hud* +2~2?1 ↑1");
  assert.equal(strip(toAnsi(render(baseState(), { cfg: { ...cfg, showGitCounts: false }, git: g }))), "proj │ ⎇ feat/hud* ↑1");
});

test("env: counts AGENTS.md, MCP servers and skills and renders compactly", async () => {
  const toml = [
    "# [mcp_servers.commented]",
    "[mcp_servers.alpha]",
    'command = "a"',
    "[mcp_servers.alpha.env]",
    'K = "V"',
    '[mcp_servers."beta-1"]',
    'command = "b"',
    'notes = """',
    "[mcp_servers.inside_string]",
    '"""',
  ].join("\n");
  assert.equal(countMcpServers(toml), 2);

  const root = tmp();
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(join(home, "skills", "s1"), { recursive: true });
  mkdirSync(join(home, "skills", ".system"), { recursive: true });
  mkdirSync(join(cwd, ".agents", "skills", "s2"), { recursive: true });
  writeFileSync(join(home, "config.toml"), toml);
  writeFileSync(join(home, "AGENTS.md"), "");
  writeFileSync(join(cwd, "AGENTS.md"), "# rules\n");

  const info = await collectEnv(cwd, home);
  assert.deepEqual(info, { agentsMd: 1, mcps: 2, skills: 2 });

  const cfg = { ...DEFAULTS, segments: ["env"] };
  assert.equal(strip(toAnsi(render(baseState(), { cfg, env: info }))), "1 AGENTS·2 MCPs·2 skills");
  assert.equal(render(baseState(), { cfg, env: { agentsMd: 0, mcps: 0, skills: 0 } }), null);
});

test("transcript & render: session segment tracks duration, turns and patched files", () => {
  const a = emptyActivity();
  const ev = (type, payload, ts) => JSON.stringify({ timestamp: ts, type, payload });
  applyLine(a, ev("event_msg", { type: "task_started" }, "2026-11-20T00:00:00Z"));
  applyLine(a, ev("response_item", {
    type: "custom_tool_call",
    call_id: "p1",
    name: "apply_patch",
    input: "*** Begin Patch\n*** Update File: src/a.mjs\n*** Add File: src/b.mjs\n*** End Patch",
  }, "2026-11-20T00:02:00Z"));
  applyLine(a, ev("event_msg", { type: "task_started" }, "2026-11-20T00:05:00Z"));

  assert.equal(a.turns, 2);
  assert.equal(a.editedFiles.size, 2);
  assert.equal(a.sessionStartedAt, Date.parse("2026-11-20T00:00:00Z"));

  const cfg = { ...DEFAULTS, segments: ["session"] };
  const now = Date.parse("2026-11-20T00:14:00Z");
  assert.equal(strip(toAnsi(render(baseState(), { cfg, activity: a, now }))), "⏱ 14m #2 ✎ 2");
});

test("transcript & render: token_count fallback populates context and cache rate", () => {
  const a = emptyActivity();
  applyLine(a, JSON.stringify({
    timestamp: "2026-11-20T00:01:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 500_000, cached_input_tokens: 450_000, output_tokens: 12_000 },
        last_token_usage: { input_tokens: 190_000, output_tokens: 10_000, total_tokens: 200_000 },
        model_context_window: 400_000,
      },
    },
  }));
  const cfg = { ...DEFAULTS, segments: ["context", "tokens"] };
  const emptyUsage = baseState({ usage: { context: {} } });
  assert.equal(strip(toAnsi(render(emptyUsage, { cfg, activity: a }))), "Context ████░░░░ 50% 200k/400k │ ↑500k ↓12k cache 90%");

  // Fresh session with only context_window_size still renders 0% context.
  const fresh = baseState({ usage: { context: { context_window_size: 400_000 } } });
  assert.equal(strip(toAnsi(render(fresh, { cfg: { ...DEFAULTS, segments: ["context"] } }))), "Context ░░░░░░░░ 0% 0/400k");

  // Brand-new session with empty usage falls back to models_cache contextWindow (or 0%).
  assert.equal(
    strip(toAnsi(render(emptyUsage, { cfg: { ...DEFAULTS, segments: ["context"] }, contextWindow: 500_000 }))),
    "Context ░░░░░░░░ 0% 0/500k",
  );
  assert.equal(
    strip(toAnsi(render(emptyUsage, { cfg: { ...DEFAULTS, segments: ["context"] } }))),
    "Context ░░░░░░░░ 0%",
  );
});

test("env & render: falls back to latest rollout rate_limits when snapshot account.rate_limits is empty", async () => {
  const home = tmp();
  const dir = join(home, "sessions", "2026", "11", "20");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rollout-2026-11-20T10-00-00-old.jsonl"),
    `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          limit_name: null,
          primary: { used_percent: 12, window_minutes: 10080, resets_at: 2000 + 86400 },
          secondary: null,
        },
      },
    })}\n`,
  );
  // Newer empty rollout (brand new session) is skipped in favor of the latest rollout with rate_limits.
  writeFileSync(join(dir, "rollout-2026-11-20T22-00-00-new.jsonl"), '{"type":"session_meta"}\n');

  const snaps = await collectLatestRateLimits(home, 2000 * 1000);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].primary_limit.used_percent, 12);

  const tree = render(baseState(), {
    cfg: { ...DEFAULTS, segments: ["limits", "tools"] },
    rateLimits: snaps,
    activity: { ...emptyActivity(), tools: new Map([["exec_command", 2]]) },
    now: 2000 * 1000,
  });
  assert.equal(strip(toAnsi(tree)), "Usage 7d █░░░░░░░ 12% ↻1d ⚙ exec_command×2");
});

// ---- groups ----

test("config: groups are sanitized, replace segments, and are on by default", () => {
  assert.deepEqual(sanitize({}).groups, [["model", "project"], ["context", "limits", "cost"]]);
  assert.deepEqual(DEFAULTS.groups.flat(), DEFAULTS.segments);
  const cfg = sanitize({ segments: ["cost"], groups: [["model", "nope", "project"], "context", [], ["model", "context"]] });
  assert.deepEqual(cfg.groups, [["model", "project"], ["context"]]);
  assert.deepEqual(cfg.segments, ["model", "project", "context"]);
  // A custom segment list on its own, or groups: null, turns grouping off.
  assert.equal(sanitize({ segments: ["model", "cost"] }).groups, null);
  assert.equal(sanitize({ groups: null }).groups, null);
  assert.deepEqual(sanitize({ groups: null }).segments, DEFAULTS.segments);
  // Unusable groups keep the defaults.
  assert.deepEqual(sanitize({ groups: [[], ["nope"]] }).groups, DEFAULTS.groups);
  assert.deepEqual(sanitize({ groups: "model" }).groups, DEFAULTS.groups);
});

test("render: each group is its own wrapping row, with no separator between groups", () => {
  const tree = render(baseState(), { cfg: sanitize({ groups: [["model"], ["context"]] }) });
  assert.equal(tree.type, "row");
  assert.deepEqual(tree.props, { gap: GROUP_GAP, wrap: "wrap" });
  assert.equal(tree.children.length, 2);
  for (const g of tree.children) assert.deepEqual([g.type, g.props.wrap], ["row", "wrap"]);
  assert.equal(strip(toAnsi(tree)), "gpt-5.5   Context ███░░░░░ 40%");
  assert.ok(checkLimits(tree).ok);

  // Separators still sit between segments inside a group.
  const inner = render(baseState(), { cfg: sanitize({ groups: [["model", "context"]] }) });
  assert.equal(strip(toAnsi(inner)), "gpt-5.5 │ Context ███░░░░░ 40%");

  // A group whose segments all render nothing leaves no empty row.
  const sparse = render(baseState({ agent: { state: "ready" } }), { cfg: sanitize({ groups: [["model"], ["state"]] }) });
  assert.equal(sparse.children.length, 1);

  // Groups that disagree with segments (an unsanitized cfg) fall back to the flat layout.
  const flat = render(baseState(), { cfg: { ...DEFAULTS, segments: ["model", "context"] } });
  assert.equal(strip(toAnsi(flat)), "gpt-5.5 │ Context ███░░░░░ 40%");
  assert.equal(flat.props.gap, 1);
});
