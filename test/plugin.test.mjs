// Codex plugin packaging: .codex-plugin/plugin.json, .mcp.json, .agents/plugins/marketplace.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HUD, NAME, PLUGIN_LIST_ARGS, configHasServer, pluginInstalled } from "../install.mjs";
import { runDoctor } from "../src/doctor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const plugin = json(".codex-plugin/plugin.json");
const mcp = json(".mcp.json");
const market = json(".agents/plugins/marketplace.json");
const pkg = json("package.json");
const tmp = () => mkdtempSync(join(tmpdir(), "codex-hud-plugin-"));

test("plugin manifest: name and version agree with the package and the server", () => {
  assert.equal(plugin.name, NAME);
  assert.equal(plugin.version, pkg.version);
  const hudVersion = /export const VERSION = "([^"]+)"/.exec(readFileSync(join(ROOT, "hud.mjs"), "utf8"))[1];
  assert.equal(plugin.version, hudVersion);
  assert.equal(plugin.license, pkg.license);
  assert.ok(existsSync(join(ROOT, plugin.mcpServers)), "mcpServers points at a file in the repo");
});

test(".mcp.json: one server, named like the provider selection, started with node", () => {
  assert.deepEqual(Object.keys(mcp.mcpServers), [NAME]);
  const s = mcp.mcpServers[NAME];
  assert.equal(s.command, "node", "no reliance on the executable bit after Codex copies the plugin");
  assert.equal(s.cwd, ".");
  assert.equal(resolve(ROOT, s.cwd, s.args[0]), HUD);
  // Codex starts MCP servers with a minimal environment; these must be passed through.
  for (const v of ["HOME", "PATH", "CODEX_HOME", "XDG_CONFIG_HOME", "CODEX_HUD_CONFIG", "CODEX_HUD_DISABLE"]) {
    assert.ok(s.env_vars.includes(v), `env_vars passes ${v}`);
  }
});

test("marketplace: lists the plugin at a path that holds its manifest", () => {
  assert.equal(market.name, NAME);
  const entry = market.plugins.find((p) => p.name === NAME);
  assert.ok(entry);
  assert.equal(entry.source.source, "local");
  // Paths are relative to the repository root (the directory holding .agents/).
  const dir = resolve(ROOT, entry.source.path);
  assert.equal(relative(ROOT, dir), "");
  assert.equal(JSON.parse(readFileSync(join(dir, ".codex-plugin", "plugin.json"), "utf8")).name, NAME);
});

test(".mcp.json command answers MCP from the plugin root with a minimal environment", async () => {
  const s = mcp.mcpServers[NAME];
  const env = { HOME: process.env.HOME, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CODEX_HOME: tmp() };
  const reply = await new Promise((resolveReply, reject) => {
    const p = spawn(s.command, s.args, { cwd: resolve(ROOT, s.cwd), env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolveReply(out));
    p.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  });
  const tool = JSON.parse(reply.trim()).result.tools[0];
  assert.deepEqual(tool._meta["openai/ui"].entrypoints, [{ type: "statusline", resourceUri: "ui://codex-hud/footer" }]);
});

test("pluginInstalled reads `codex plugin list --json`", () => {
  const entry = (over) => ({ pluginId: "codex-hud@mkt", name: "codex-hud", marketplaceName: "mkt", installed: true, enabled: true, ...over });
  const out = (...installed) => JSON.stringify({ installed, available: [] });
  assert.equal(pluginInstalled(out(entry())), "codex-hud@mkt");
  assert.equal(pluginInstalled(out(entry({ enabled: false }))), null, "a disabled plugin supplies no server");
  assert.equal(pluginInstalled(out(entry({ name: "my-codex-hud", pluginId: "my-codex-hud@x" }))), null);
  assert.equal(pluginInstalled(out()), null);
  assert.equal(pluginInstalled("{}"), null);
});

test("installer and doctor ask for the JSON listing (the text one is megabytes)", () => {
  assert.deepEqual([...PLUGIN_LIST_ARGS], ["plugin", "list", "--json"]);
});

test("pluginInstalled falls back to the text listing", () => {
  const listing = [
    "Marketplace `codex-hud`",
    "codex-hud@codex-hud  installed, enabled  0.1.0    /src/codex-hud",
    "huddo@openai-curated-remote   not installed   0.10.2",
  ].join("\n");
  assert.equal(pluginInstalled(listing), "codex-hud@codex-hud");
  assert.equal(pluginInstalled("codex-hud@codex-hud  not installed  0.1.0"), null);
  assert.equal(pluginInstalled("my-codex-hud@x  installed, enabled"), null);
  assert.equal(pluginInstalled(null), null);
});

test("installer refuses to add a second codex-hud next to the plugin", () => {
  const bin = tmp();
  const home = tmp();
  writeFileSync(join(home, "config.toml"), 'model = "x"\n');
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
case "$1 $2" in
  "features list") echo "tui_extensions_statusline  experimental  false" ;;
  "plugin list") echo '{"installed":[{"pluginId":"codex-hud@codex-hud","name":"codex-hud","marketplaceName":"codex-hud","version":"0.1.0","installed":true,"enabled":true}]}' ;;
  "mcp get") exit 1 ;;
  *) echo "unexpected: $*" >&2; exit 3 ;;
esac
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
  let out = "";
  let code = 0;
  try {
    execFileSync(process.execPath, [join(ROOT, "install.mjs")], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    code = e.status;
    out = `${e.stdout}${e.stderr}`;
  }
  assert.equal(code, 1);
  assert.match(out, /already installed as the plugin codex-hud@codex-hud/);
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), 'model = "x"\n', "nothing was changed");
});

test("doctor: plugin install counts as registered; plugin + config entry is a duplicate", async () => {
  const listing = { ok: true, stdout: `{"installed":[{"pluginId":"codex-hud@codex-hud","name":"codex-hud","marketplaceName":"codex-hud","version":"0.1.0","installed":true,"enabled":true}]}`, stderr: "" };
  const fake = (mcpGet) => (cmd, args) => {
    if (args[0] === "plugin") return listing;
    if (args[0] === "mcp") return mcpGet;
    if (args[0] === "features") return { ok: true, stdout: "tui_extensions_statusline  experimental  true\n", stderr: "" };
    if (args[0] === "--version") return { ok: true, stdout: "codex-cli 0.171.0\n", stderr: "" };
    return { ok: false, stdout: "", stderr: "" };
  };
  const doctor = (run) => runDoctor({ env: { ...process.env, CODEX_HOME: tmp() }, run, version: "0.1.0" });

  const viaPlugin = (await doctor(fake({ ok: false, stdout: "", stderr: "not found" }))).checks.find((c) => c.id === "mcp");
  assert.equal(viaPlugin.status, "ok");
  assert.match(viaPlugin.summary, /plugin codex-hud@codex-hud/);

  // `codex mcp get` also reports the plugin's own server (relative path + plugin cwd).
  const pluginGet = {
    ok: true,
    stdout: JSON.stringify({ transport: { command: "node", args: ["./hud.mjs"], cwd: ROOT, env_vars: ["CODEX_HOME"] } }),
    stderr: "",
  };
  const home = tmp();
  const cfg = join(home, "config.toml");
  writeFileSync(cfg, 'model = "x"\n');
  const doctorIn = (run) => runDoctor({ env: { ...process.env, CODEX_HOME: home }, run, version: "0.1.0" });
  const plain = (await doctorIn(fake(pluginGet))).checks.find((c) => c.id === "mcp");
  assert.equal(plain.status, "ok", plain.summary);
  assert.match(plain.summary, /^plugin codex-hud@codex-hud: node \.\/hud\.mjs$/);

  // Same plugin, plus a [mcp_servers.codex-hud] table in config.toml: two servers.
  writeFileSync(cfg, 'model = "x"\n[mcp_servers.codex-hud]\ncommand = "node"\n');
  const both = (await doctorIn(fake(pluginGet))).checks.find((c) => c.id === "mcp");
  assert.equal(both.status, "warn");
  assert.match(both.summary, /registered twice/);
});

test("doctor: relative server paths resolve against the server cwd, not the shell's", async () => {
  const get = (cwd) => ({
    ok: true,
    stdout: JSON.stringify({ transport: { command: "node", args: ["./hud.mjs"], cwd, env_vars: ["CODEX_HOME"] } }),
    stderr: "",
  });
  const run = (cwd) => (cmd, args) => (args[0] === "mcp" ? get(cwd) : { ok: false, stdout: "", stderr: "" });
  const check = async (cwd) => (await runDoctor({ env: { ...process.env, CODEX_HOME: tmp() }, run: run(cwd), version: "0" })).checks.find((c) => c.id === "mcp");
  assert.equal((await check(ROOT)).status, "ok");
  const elsewhere = await check(tmp());
  assert.equal(elsewhere.status, "warn");
  assert.match(elsewhere.summary, /file not found: \.\/hud\.mjs/);
});

test("doctor: a registration through the removed bin/ launcher is flagged", async () => {
  const run = (cmd, args) =>
    args[0] === "mcp"
      ? { ok: true, stdout: JSON.stringify({ transport: { command: "/bin/sh", args: [join(ROOT, "bin", "codex-hud.sh")] } }), stderr: "" }
      : { ok: false, stdout: "", stderr: "" };
  const c = (await runDoctor({ env: { ...process.env, CODEX_HOME: tmp() }, run, version: "0" })).checks.find((x) => x.id === "mcp");
  assert.equal(c.status, "warn");
  assert.match(c.summary, /removed bin\/ launcher/);
  assert.match(c.hint, /node install\.mjs/);
});

test("configHasServer: only a server defined in config.toml counts", () => {
  assert.equal(configHasServer('[mcp_servers.codex-hud]\ncommand = "x"\n'), true);
  assert.equal(configHasServer('[mcp_servers."codex-hud".env]\nA = "1"\n'), true);
  assert.equal(configHasServer('[mcp_servers]\ncodex-hud = { command = "x" }\n'), true);
  assert.equal(configHasServer('mcp_servers.codex-hud.command = "x"\n'), true);
  assert.equal(configHasServer('mcp_servers = { other = { args = ["a,b"] }, "codex-hud" = { command = "node" } } # comment'), true);
  assert.equal(configHasServer([
    'mcp_servers = { other = { args = [',
    '  "a,b", # ] },',
    '] }, "codex-hud" = { command = "node" } }',
  ].join("\n")), true);
  assert.equal(configHasServer([
    'mcp_servers = { other = { env = { NOTE = """',
    '}, codex-hud = { # inside a string',
    '""" } } }',
  ].join("\n")), false);
  assert.equal(configHasServer('mcp_servers = { other = { env = { codex-hud = "x" } } } # codex-hud'), false);
  assert.equal(configHasServer('[mcp_servers.other]\nargs = ["codex-hud"]\n'), false);
  assert.equal(configHasServer('[tui]\nstatus_line_provider = { server = "codex-hud", tool = "statusline" }\n'), false);
  assert.equal(configHasServer('notes = """\n[mcp_servers.codex-hud]\n"""\n'), false);
});

test("installer --uninstall leaves a plugin-supplied server alone", () => {
  const bin = tmp();
  const home = tmp();
  const calls = join(home, "calls.log");
  const original = 'model = "x"\n\n[tui]\nstatus_line_provider = { server = "codex-hud", tool = "statusline" }\n';
  writeFileSync(join(home, "config.toml"), original);
  // `codex mcp get` succeeds because the plugin supplies the server; config.toml has no table.
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "features list") echo "tui_extensions_statusline  experimental  true" ;;
  "plugin list") echo '{"installed":[{"pluginId":"codex-hud@codex-hud","name":"codex-hud","marketplaceName":"codex-hud","version":"0.1.0","installed":true,"enabled":true}]}' ;;
  "mcp get") echo '{"name":"codex-hud"}' ;;
  "mcp remove") echo "No MCP server named 'codex-hud' found." >&2; exit 1 ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
  const out = execFileSync(process.execPath, [join(ROOT, "install.mjs"), "--uninstall"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(out, /Removed/);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /mcp remove/);
  assert.doesNotMatch(readFileSync(join(home, "config.toml"), "utf8"), /status_line_provider/);
});
