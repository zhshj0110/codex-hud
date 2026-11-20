// Colour policy: theme (status-*) colours in the normal state, ANSI + marker only for alerts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";
import { level, render, toAnsi, PREVIEW_THEMES } from "../src/render.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Every text node as { text, color, bold, italic }.
function texts(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "text") {
    out.push({
      text: node.children.join(""),
      color: node.props.color ?? null,
      bold: node.props.weight === "bold",
      italic: !!node.props.italic,
    });
  }
  for (const c of node.children || []) texts(c, out);
  return out;
}

const state = ({ ctx = 40, five = 10, week = 20, agent = "working", tier } = {}) => ({
  account: {
    rate_limits: [{
      limit_id: "codex",
      primary_limit: { used_percent: five, window_minutes: 300, resets_at: null },
      secondary_limit: { used_percent: week, window_minutes: 10080, resets_at: null },
    }],
  },
  thread: {
    id: "t",
    agent: { state: agent },
    model: { display_name: "gpt", provider: "openai", reasoning_level: "high", service_tier: tier },
    workspace: { cwd: "/tmp/proj" },
    usage: { context: { used_percentage: ctx }, cost: { total_cost_usd: 1.5 } },
  },
});
const activity = {
  turnStartedAt: 0,
  tools: new Map([["exec_command", 2]]),
  lastCommand: "npm test",
  plan: { done: 2, total: 2, current: null },
};
const opts = {
  cfg: { ...DEFAULTS, segments: [...DEFAULTS.segments, "tools", "state"] },
  git: { branch: "main", ahead: 1, behind: 0, dirty: 1 },
  activity,
  now: 60_000,
};

test("level is decided on the displayed (rounded) percentage", () => {
  assert.equal(level(69.4, DEFAULTS), "ok");
  assert.equal(level(69.6, DEFAULTS), "warn", "shown as 70% so it must not look normal");
  assert.equal(level(89.5, DEFAULTS), "danger");
  assert.equal(level(100, { warn: 101, danger: 101 }), "ok", "alerts can be switched off");
});

test("normal state uses only theme colours or the default foreground", () => {
  const nodes = texts(render(state({ tier: "fast" }), opts));
  assert.ok(nodes.length > 15);
  for (const n of nodes) {
    assert.ok(n.color === null || n.color.startsWith("status-"), `${JSON.stringify(n.text)} uses ${n.color}`);
  }
  assert.ok(!nodes.some((n) => n.text.includes("!")), "no alert marker when nothing is high");
});

test("surface and accent are never used", () => {
  for (const s of [state(), state({ ctx: 95, five: 75, agent: "waiting", tier: "priority" })]) {
    const colors = texts(render(s, opts)).map((n) => n.color);
    assert.ok(!colors.includes("surface") && !colors.includes("accent"));
  }
});

test("meters: theme bar, default-foreground bold percentage", () => {
  const nodes = texts(render(state({ ctx: 40, five: 10, week: 20 }), { ...opts, cfg: { ...DEFAULTS, segments: ["context", "limits"] } }));
  const at = (label) => nodes.slice(nodes.findIndex((n) => n.text === label));
  const [ctxLabel, ctxBar, ctxPct] = at("Context");
  assert.deepEqual([ctxLabel.color, ctxBar.color], ["status-usage", "status-usage"]);
  assert.equal(ctxPct.text, "40%");
  assert.equal(ctxPct.color, null);
  assert.ok(ctxPct.bold);
  const [, fiveBar, fivePct] = at("5h");
  assert.equal(fiveBar.color, "status-limit");
  assert.equal(fivePct.color, null);
});

test("warn and danger: ANSI bar plus ! / !! marker, value stays default foreground", () => {
  const tree = render(state({ ctx: 74, five: 95, week: 69.6 }), { ...opts, cfg: { ...DEFAULTS, segments: ["context", "limits"] } });
  const line = strip(toAnsi(tree));
  assert.match(line, /Context ██████░░ ! 74%/);
  assert.match(line, /5h ████████ !! 95%/);
  assert.match(line, /7d ██████░░ ! 70%/);
  const nodes = texts(tree);
  const ctxIdx = nodes.findIndex((n) => n.text === "Context");
  const [label, barNode, mark, pct] = nodes.slice(ctxIdx, ctxIdx + 4);
  assert.equal(label.color, "status-usage", "label keeps the theme colour");
  assert.equal(barNode.color, "yellow");
  assert.deepEqual([mark.text, mark.color, mark.bold], ["!", "yellow", true]);
  assert.equal(pct.color, null);
  const danger = nodes[nodes.findIndex((n) => n.text === "5h") + 2];
  assert.deepEqual([danger.text, danger.color], ["!!", "red"]);
});

test("other elements follow the theme", () => {
  const nodes = texts(render(state({ agent: "working", tier: "fast" }), opts));
  const find = (t) => nodes.find((n) => n.text === t || n.text.startsWith(t));
  assert.equal(find("⚡").color, "status-model");
  assert.deepEqual([find("npm test").color, find("npm test").italic], ["status-metadata", true]);
  const plan = find("☑");
  assert.deepEqual([plan.color, plan.bold], ["status-progress", true]);
  const unfinished = texts(render(state(), { ...opts, activity: { ...activity, plan: { done: 1, total: 2 } } })).find((n) => n.text.startsWith("☑"));
  assert.deepEqual([unfinished.color, unfinished.bold], ["status-progress", false]);
});

test("waiting is told apart from working by glyph, not colour", () => {
  const stateNode = (agent) => texts(render(state({ agent }), { ...opts, cfg: { ...DEFAULTS, segments: ["state"] } }))[0];
  const waiting = stateNode("waiting");
  const working = stateNode("working");
  assert.equal(waiting.text, "◌ waiting");
  assert.equal(working.text, "● working");
  assert.equal(waiting.color, working.color);
  assert.equal(stateNode("starting").color, "status-metadata");
});

test("preview reproduces the captured theme colours", () => {
  const tree = render(state(), { ...opts, cfg: { ...DEFAULTS, segments: ["model"] } });
  assert.match(toAnsi(tree, {}, "dracula"), /38;2;102;217;239/);
  assert.match(toAnsi(tree, {}, "one-half-light"), /38;2;228;86;73/);
  assert.ok(PREVIEW_THEMES.dracula["status-usage"]);
  const warn = render(state({ ctx: 80 }), { ...opts, cfg: { ...DEFAULTS, segments: ["context"] } });
  assert.match(toAnsi(warn), /\x1b\[33m█/, "ANSI names stay terminal-palette codes");
});
