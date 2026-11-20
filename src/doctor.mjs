// `node hud.mjs --doctor [--json]`: checks everything the footer depends on, from
// Node and Codex to the MCP registration, the [tui] provider, the user config,
// the Nerd Font glyphs and the size of a rendered footer.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { BOOLEANS, DEFAULTS, MAX_CONFIG_BYTES, RANGES, SEGMENTS, codexHome, configSource, sanitize } from "./config.mjs";
import { GLYPHS, checkLimits, render, toAnsi } from "./render.mjs";
import { FEATURE, MANAGED_NODE, NAME, PROVIDER_LINE, configHasServer, isOurProvider, PLUGIN_LIST_ARGS, pluginInstalled, readProvider } from "../install.mjs";

const MIN_NODE = 18;

export function which(cmd, env = process.env, platform = process.platform) {
  const exts = platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (env.PATH || env.Path || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, cmd + ext);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

function defaultRun(cmd, args, { env = process.env } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env,
    timeout: 15_000,
    windowsHide: true,
    // `codex` is usually codex.cmd on Windows, which needs a shell; the arguments are constants.
    shell: process.platform === "win32" && cmd === "codex",
  });
  return {
    ok: !r.error && r.status === 0,
    stdout: r.stdout || "",
    stderr: (r.stderr || "").trim(),
    error: r.error ? r.error.message : null,
  };
}

const firstLine = (s) => String(s || "").trim().split(/\r?\n/)[0] || "";

// Exercises every segment with long values, to show the headroom under Codex's limits.
function stressTree(cfg) {
  const long = "x".repeat(5000);
  const rate = (i) => ({
    limit_id: i ? `extra${i}` : "codex",
    limit_name: long,
    primary_limit: { used_percent: 95, window_minutes: 300, resets_at: 4e9 },
    secondary_limit: { used_percent: 75, window_minutes: 10080, resets_at: 4e9 },
  });
  const state = {
    app: { cli_version: "0.171.0", display_mode: "raw" },
    config: { statusline_items: [], profile: long },
    account: { rate_limits: Array.from({ length: 10 }, (_, i) => rate(i)) },
    thread: {
      id: "doctor",
      name: `${long}\n${long}`,
      agent: { state: "working" },
      model: { display_name: long, provider: long, reasoning_level: long, service_tier: "fast" },
      workspace: { cwd: `/${long}` },
      permissions: { type: "managed", display_name: long, file_system: { type: "restricted" }, network: "restricted" },
      approval: { policy: "on-request", reviewer: "auto-review" },
      usage: {
        context: { used_percentage: 99, used_tokens: 1e9, context_window_size: 1e9 },
        total: { total_input_tokens: 2e6, cache_read_input_tokens: 1.5e6, cache_write_input_tokens: 0, other_input_tokens: 5e5, output_tokens: 3e5 },
        cost: { total_cost_usd: 1e6 },
      },
    },
  };
  const tools = new Map(Array.from({ length: 20 }, (_, i) => [`${long}${i}`, 1e6]));
  const activity = {
    sessionStartedAt: 0,
    turns: 12,
    turnStartedAt: 0,
    tools,
    editedFiles: new Set(["a.js", "b.js", "c.js"]),
    running: new Map([["c", [...tools.keys()]]]),
    lastCommand: long,
    plan: { done: 1, total: 3, current: long },
  };
  const all = { ...cfg, segments: [...SEGMENTS], allLimits: true, maxTools: RANGES.maxTools[1], barWidth: RANGES.barWidth[1] };
  for (const k of ["lastCommandWidth", "planCurrentWidth", "titleWidth"]) all[k] = RANGES[k][1];
  return render(state, {
    cfg: all,
    git: { branch: long, ahead: 99, behind: 99, dirty: 9, staged: 3, modified: 4, untracked: 2 },
    env: { agentsMd: 2, mcps: 8, skills: 15 },
    activity,
    now: 600_000,
  });
}

function checkUserConfig(env) {
  const { path, from } = configSource(env);
  const base = { id: "config", title: "User config", details: { path, from } };
  let raw;
  try {
    const st = statSync(path);
    if (st.size > MAX_CONFIG_BYTES) {
      return { ...base, status: "warn", summary: `${path} is over ${MAX_CONFIG_BYTES / 1024} KiB and is ignored`, effective: sanitize(null) };
    }
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { ...base, status: "ok", summary: `${path} (${from}) not found, using defaults`, effective: sanitize(null) };
    }
    return { ...base, status: "warn", summary: `cannot read ${path}: ${e.message}`, effective: sanitize(null) };
  }
  let user;
  try {
    user = JSON.parse(raw);
  } catch (e) {
    return {
      ...base,
      status: "warn",
      summary: `${path} is not valid JSON (${e.message}); defaults are used`,
      effective: sanitize(null),
    };
  }
  const effective = sanitize(user);
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    return { ...base, status: "warn", summary: `${path} must hold a JSON object; defaults are used`, effective };
  }
  const unknown = Object.keys(user).filter((k) => !(k in DEFAULTS));
  const ignored = Object.keys(user).filter((k) => {
    const v = user[k];
    if (k === "segments") return !Array.isArray(v) || v.some((s) => !SEGMENTS.includes(s));
    if (k in RANGES) return typeof v !== "number" || !Number.isFinite(v);
    if (BOOLEANS.includes(k)) return typeof v !== "boolean";
    return false;
  });
  const notes = [];
  if (unknown.length) notes.push(`unknown keys: ${unknown.join(", ")}`);
  if (ignored.length) notes.push(`invalid values ignored: ${ignored.join(", ")}`);
  return {
    ...base,
    status: notes.length ? "warn" : "ok",
    summary: `${path} (${from})${notes.length ? `: ${notes.join("; ")}` : " is valid"}`,
    details: { ...base.details, unknown, ignored },
    effective,
  };
}

function checkRegistration(run, env) {
  const base = { id: "mcp", title: "MCP server" };
  const r = run("codex", ["mcp", "get", NAME, "--json"]);
  const listed = run("codex", [...PLUGIN_LIST_ARGS]);
  const plugin = listed.ok ? pluginInstalled(listed.stdout) : null;
  if (!r.ok) {
    if (plugin) {
      return { ...base, status: "ok", summary: `installed as the Codex plugin ${plugin}`, details: { plugin } };
    }
    return {
      ...base,
      status: "warn",
      summary: `"${NAME}" is not registered`,
      hint: "run: node install.mjs (or install the plugin: codex plugin add codex-hud@codex-hud)",
    };
  }
  // `codex mcp get` also reports plugin servers, so look at config.toml for a second copy.
  let configText = "";
  try {
    configText = readFileSync(join(codexHome(env), "config.toml"), "utf8");
  } catch {}
  if (plugin && configHasServer(configText)) {
    return {
      ...base,
      status: "warn",
      summary: `registered twice: [mcp_servers.${NAME}] in config.toml and the plugin ${plugin}`,
      hint: `keep one: node install.mjs --uninstall, or codex plugin remove ${plugin}`,
      details: { plugin },
    };
  }
  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    return { ...base, status: "warn", summary: `"${NAME}" is registered, but \`codex mcp get --json\` was not JSON` };
  }
  const t = info.transport || {};
  const command = typeof t.command === "string" ? t.command : "";
  const args = Array.isArray(t.args) ? t.args.map(String) : [];
  const line = [command, ...args].join(" ");
  const details = { command, args, enabled: info.enabled !== false, ...(plugin ? { plugin } : {}) };
  const problems = [];
  const hints = [];
  // Relative paths (the plugin server uses "./hud.mjs") resolve against the server's cwd.
  const cwd = typeof t.cwd === "string" && t.cwd ? t.cwd : null;
  const local = (p) => (isAbsolute(p) || !cwd ? p : resolve(cwd, p));
  const exists = (p) => (isAbsolute(p) || (cwd && /[\\/]/.test(p)) ? existsSync(local(p)) : !!which(p, env));
  if (!command || !exists(command)) problems.push(`command not found: ${command || "(none)"}`);
  for (const a of args) if (/\.(mjs|sh|cmd)$/.test(a) && !existsSync(local(a))) problems.push(`file not found: ${a}`);
  // Registrations from before the bin/ launchers were removed.
  if ([command, ...args].some((a) => /codex-hud\.(sh|cmd)$/.test(a))) {
    problems.push("uses the removed bin/ launcher");
    hints.push("rerun: node install.mjs");
  }
  if (MANAGED_NODE.test(command)) {
    problems.push(`pinned to a version-manager node (${command})`);
    hints.push("this breaks if that Node version is removed; after switching, rerun install.mjs with the new node, or run it once with a system node (e.g. /opt/homebrew/bin/node install.mjs)");
  }
  if (info.enabled === false) problems.push("server is disabled in config.toml");
  const passed = (t.env && typeof t.env === "object" ? Object.keys(t.env) : []).concat(Array.isArray(t.env_vars) ? t.env_vars : []);
  if (env.CODEX_HOME && !passed.includes("CODEX_HOME")) {
    problems.push("CODEX_HOME is set here but not passed to the server");
    hints.push("rerun node install.mjs with the same CODEX_HOME");
  }
  if (problems.length && !hints.length) hints.push("rerun: node install.mjs");
  return {
    ...base,
    status: problems.length ? "warn" : "ok",
    summary: `${plugin ? `plugin ${plugin}: ` : ""}${line}${problems.length ? ` (${problems.join("; ")})` : ""}`,
    hint: hints.join("; ") || undefined,
    details,
  };
}

function checkProvider(env) {
  const file = join(codexHome(env), "config.toml");
  const base = { id: "provider", title: "[tui] provider", details: { file } };
  let toml;
  try {
    toml = readFileSync(file, "utf8");
  } catch {
    return { ...base, status: "warn", summary: `${file} not found`, hint: "run: node install.mjs" };
  }
  const line = readProvider(toml);
  if (!line) {
    return {
      ...base,
      status: "warn",
      summary: "no status_line_provider in [tui]: Codex shows its built-in footer",
      hint: `pick codex-hud in /statusline, run node install.mjs (non-plugin installs), or add under [tui]: ${PROVIDER_LINE}`,
    };
  }
  if (!isOurProvider(line)) {
    return { ...base, status: "warn", summary: `another provider is selected: ${line}`, hint: "pick codex-hud in /statusline" };
  }
  return { ...base, status: "ok", summary: line };
}

export async function runDoctor({
  env = process.env,
  run = defaultRun,
  platform = process.platform,
  nodeVersion = process.versions.node,
  execPath = process.execPath,
  buildTree = null,
  sampleState = null,
  version = "",
} = {}) {
  const checks = [];
  const major = Number(nodeVersion.split(".")[0]);
  const pathNode = which("node", env, platform);
  checks.push({
    id: "node",
    title: "Node.js",
    status: major >= MIN_NODE ? "ok" : "fail",
    summary: `v${nodeVersion} (${execPath})${pathNode && pathNode !== execPath ? `; PATH node: ${pathNode}` : ""}`,
    hint: major >= MIN_NODE ? undefined : `codex-hud needs Node.js ${MIN_NODE}+`,
    details: { version: nodeVersion, execPath, pathNode },
  });

  const codexPath = which("codex", env, platform);
  if (!codexPath) {
    checks.push({ id: "codex", title: "Codex CLI", status: "fail", summary: "codex not found on PATH", hint: "install the Codex CLI (0.171+)" });
  } else {
    const v = run("codex", ["--version"]);
    checks.push({
      id: "codex",
      title: "Codex CLI",
      status: v.ok ? "ok" : "fail",
      summary: `${v.ok ? firstLine(v.stdout) : `\`codex --version\` failed: ${firstLine(v.stderr) || v.error}`} (${codexPath})`,
      details: { path: codexPath, version: v.ok ? firstLine(v.stdout) : null },
    });
    const f = run("codex", ["features", "list"]);
    const m = f.ok && new RegExp(`^${FEATURE}\\s+(.*?)\\s+(true|false)\\s*$`, "m").exec(f.stdout);
    let feature;
    if (!f.ok) {
      feature = { status: "fail", summary: `\`codex features list\` failed: ${firstLine(f.stderr) || f.error}`, hint: "is config.toml valid?" };
    } else if (!m) {
      feature = { status: "fail", summary: `this Codex build has no ${FEATURE}`, hint: "upgrade Codex (0.171+ is known to work)" };
    } else if (m[2] !== "true") {
      feature = { status: "warn", summary: `${FEATURE} (${m[1]}) is available but disabled`, hint: `run node install.mjs or: codex features enable ${FEATURE}` };
    } else {
      feature = { status: "ok", summary: `${FEATURE} (${m[1]}) enabled` };
    }
    checks.push({ id: "feature", title: "Statusline feature", ...feature, details: { available: !!m, enabled: !!m && m[2] === "true" } });
    checks.push(checkRegistration(run, env));
  }
  checks.push(checkProvider(env));

  const config = checkUserConfig(env);
  const effective = config.effective;
  delete config.effective;
  config.details.effective = effective;
  checks.push(config);
  if (env.CODEX_HUD_DISABLE === "1") {
    checks.push({ id: "disabled", title: "CODEX_HUD_DISABLE", status: "warn", summary: "set to 1 here: the footer would be empty" });
  }

  const sample = (g) => `${g.model ? `${g.model} ` : ""}model  ${g.folder ? `${g.folder} ` : ""}dir  ${g.branch} branch  ${g.mode} mode  ${g.tools} tools  ${g.plan} plan  ${g.edit} edit  ${g.clock} time  ${g.reset} reset  ${g.fast} fast  ${g.running} running`;
  const icons = { enabled: effective.icons, plain: sample(GLYPHS.plain), nerd: sample(GLYPHS.nerd) };

  let preview = null;
  if (buildTree && sampleState) {
    const tree = await buildTree(sampleState);
    preview = { tree, line: toAnsi(tree), limits: checkLimits(tree) };
  }
  const stress = checkLimits(stressTree(effective));
  const okLimits = (!preview || preview.limits.ok) && stress.ok;
  const fmt = (l) => `${l.bytes} B json, ${l.nodes} nodes, depth ${l.depth}, ${l.textBytes} B text`;
  checks.push({
    id: "render",
    title: "Render limits",
    status: okLimits ? "ok" : "fail",
    summary: `${preview ? `sample: ${fmt(preview.limits)}; ` : ""}worst case: ${fmt(stress)} (max 65536 B / 256 / 16 / 16384 B)`,
    details: { sample: preview && preview.limits, stress },
  });

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status]++;
  return { version, ok: counts.fail === 0, counts, checks, icons, preview: preview && { line: preview.line, limits: preview.limits } };
}

const MARK = { ok: "✓", warn: "!", fail: "✗" };

export function formatReport(report, { color = false } = {}) {
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const tint = { ok: "32", warn: "33", fail: "31" };
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const out = [`codex-hud doctor ${report.version ? `v${report.version}` : ""}`.trim(), ""];
  for (const c of report.checks) {
    out.push(`  ${paint(tint[c.status], MARK[c.status])} ${c.title.padEnd(18)} ${c.summary}`);
    if (c.hint && c.status !== "ok") out.push(`    ${" ".repeat(18)} → ${c.hint}`);
  }
  const effective = report.checks.find((c) => c.id === "config");
  if (effective) out.push("", `Effective config: ${JSON.stringify(effective.details.effective)}`);
  out.push(
    "",
    `Nerd Font probe ("icons" is ${report.icons.enabled ? "on" : "off"}). If the nerd row shows boxes, "?" or blanks, keep "icons": false:`,
    `  plain  ${report.icons.plain}`,
    `  nerd   ${report.icons.nerd}`,
  );
  if (report.preview) {
    out.push("", "Preview (sample snapshot, effective config):", `  ${color ? report.preview.line : strip(report.preview.line) || "(empty footer)"}`);
  }
  const { ok, warn, fail } = report.counts;
  out.push("", `${ok} ok, ${warn} warning${warn === 1 ? "" : "s"}, ${fail} failure${fail === 1 ? "" : "s"}`);
  return out.join("\n");
}
