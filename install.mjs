#!/usr/bin/env node
// Registers codex-hud as a Codex statusline provider.
//
//   node install.mjs              enable feature + register MCP server + select provider
//   node install.mjs --no-select  leave the provider choice to /statusline
//   node install.mjs --uninstall  undo all of the above
//   node install.mjs --dry-run    print what would change
//
// The server is registered as <the node running this script> hud.mjs. To register a
// different Node, run this script with it: /path/to/node install.mjs
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome, configPath } from "./src/config.mjs";

export const NAME = "codex-hud";
export const FEATURE = "tui_extensions_statusline";
export const PROVIDER_LINE = `status_line_provider = { server = "${NAME}", tool = "statusline" }`;
const ROOT = dirname(fileURLToPath(import.meta.url));
export const HUD = resolve(ROOT, "hud.mjs");
// Paths owned by a Node version manager: the registration breaks if that version is removed.
export const MANAGED_NODE = /[\\/](\.nvm|nvm|fnm|\.fnm|\.volta|mise|rtx|\.asdf|\.nodenv|n[\\/]versions)[\\/]/;

// The command registered with `codex mcp add`: the absolute path of the node running
// the installer, so Codex's minimal PATH does not need to contain node.
export function launchCommand({ execPath = process.execPath } = {}) {
  return [execPath, HUD];
}

export class UnsupportedConfig extends Error {}

// ---- minimal TOML structure scanner ----
// Not a TOML parser: it only tracks enough (strings, multi-line strings, comments,
// bracket depth) to tell which lines start a key or table at the top level.

// The part of a line before any comment, honouring single-line strings.
export function codePart(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "#") return line.slice(0, i);
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += c === '"' && line[j] === "\\" ? 2 : 1;
      i = j;
    }
  }
  return line;
}

export function scanLines(text) {
  let multi = null; // '"""' or "'''" while inside a multi-line string
  let depth = 0; // open [ / { across lines (multi-line arrays)
  return text.split("\n").map((line) => {
    const top = !multi && depth === 0;
    let i = 0;
    for (; i < line.length; ) {
      if (multi) {
        if (multi === '"""' && line[i] === "\\") i += 2;
        else if (line.startsWith(multi, i)) {
          const quote = multi[0];
          i += 3;
          if (line[i] === quote) i++;
          if (line[i] === quote) i++;
          multi = null;
        } else i++;
        continue;
      }
      const c = line[i];
      if (c === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multi = line.slice(i, i + 3);
        i += 3;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += c === '"' && line[j] === "\\" ? 2 : 1;
        i = j + 1;
      } else {
        if (c === "[" || c === "{") depth++;
        else if ((c === "]" || c === "}") && depth > 0) depth--;
        i++;
      }
    }
    return { text: line, code: line.slice(0, i), top };
  });
}

const TOML_STRING = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'`;
const TOML_KEY = `(?:${TOML_STRING}|[A-Za-z0-9_-]+)`;
const KEY_PATH = String.raw`${TOML_KEY}(?:[ \t]*\.[ \t]*${TOML_KEY})*`;
const ASSIGNMENT = new RegExp(String.raw`^\s*(${KEY_PATH})\s*=\s*`);
const MULTILINE_STRING = String.raw`"""(?:\\[\s\S]|[^\\])*?"{3,5}|'''[\s\S]*?'{3,5}`;
const INLINE_TOKENS = new RegExp(String.raw`${MULTILINE_STRING}|${TOML_STRING}|[{}\[\],]`, "g");
const STRING_VALUE = new RegExp(`^(?:${TOML_STRING})$`);

function unquote(token) {
  if (token[0] === "'") return token.slice(1, -1);
  if (token[0] !== '"') return token;
  return token.slice(1, -1).replace(/\\(?:u([\da-fA-F]{4})|U([\da-fA-F]{8})|([btnfre"\\]))/g, (escape, short, long, simple) => {
    if (simple) return { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" }[simple];
    const point = Number.parseInt(short ?? long, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : escape;
  });
}

function keyPath(raw) {
  return Array.from(raw.matchAll(new RegExp(TOML_KEY, "g")), ([token]) => {
    const key = unquote(token);
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
  }).join(".");
}

// "[ tui ]" / '["tui"]' -> "tui"; "[[x]]" -> "[x]" so array tables never match a plain name.
export function headerName(line) {
  const code = codePart(line).trim();
  const arr = /^\[\[(.*)\]\]$/.exec(code);
  if (arr) return `[${keyPath(arr[1])}]`;
  const m = /^\[(.*)\]$/.exec(code);
  return m ? keyPath(m[1]) : null;
}

function keyOf(line) {
  const m = ASSIGNMENT.exec(line);
  return m ? keyPath(m[1]) : null;
}

function* inlineFields(table) {
  if (!table.startsWith("{") || !table.endsWith("}")) return;
  let depth = 0;
  let start = 1;
  for (const { 0: token, index } of table.matchAll(INLINE_TOKENS)) {
    if (depth === 1 && (token === "," || token === "}")) {
      const field = table.slice(start, index);
      const assignment = ASSIGNMENT.exec(field);
      if (assignment) yield [keyPath(assignment[1]), field.slice(assignment[0].length).trim()];
      start = index + 1;
    }
    if (token === "{" || token === "[") depth++;
    else if (token === "}" || token === "]") depth--;
  }
}

export function isOurProvider(line) {
  const code = codePart(line).trim();
  const property = ASSIGNMENT.exec(code);
  if (!property || keyPath(property[1]) !== "status_line_provider") return false;
  for (const [key, value] of inlineFields(code.slice(property[0].length))) {
    if (key === "server") return STRING_VALUE.test(value) && unquote(value) === NAME;
  }
  return false;
}

// Section-aware edit of `status_line_provider` in [tui]. Throws UnsupportedConfig for
// layouts it cannot edit safely instead of guessing.
export function setProvider(toml, on) {
  const cr = toml.includes("\r\n") ? "\r" : "";
  const lines = scanLines(toml);
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].top && /^\s*\[/.test(lines[i].text)) headers.push({ i, name: headerName(lines[i].text) });
  }
  const firstHeader = headers.length ? headers[0].i : lines.length;
  for (let i = 0; i < firstHeader; i++) {
    const key = lines[i].top && keyOf(lines[i].text);
    if (key && (key === "tui" || key.startsWith("tui."))) {
      throw new UnsupportedConfig(`line ${i + 1}: [tui] is defined with a top-level "tui" key`);
    }
  }
  if (headers.some((h) => h.name === "tui.status_line_provider" || h.name?.startsWith("tui.status_line_provider."))) {
    throw new UnsupportedConfig("status_line_provider is written as a [tui.status_line_provider] table");
  }
  const tuis = headers.filter((h) => h.name === "tui");
  if (tuis.length > 1) throw new UnsupportedConfig("config.toml has more than one [tui] table");

  const out = lines.map((l) => l.text);
  if (!tuis.length) {
    if (!on) return toml;
    return `${toml.replace(/(\r?\n)*$/, `${cr}\n`)}${cr}\n[tui]${cr}\n${PROVIDER_LINE}${cr}\n`;
  }
  const start = tuis[0].i;
  const next = headers.find((h) => h.i > start);
  const end = next ? next.i : lines.length;
  let idx = -1;
  for (let i = start + 1; i < end; i++) {
    const key = lines[i].top && keyOf(lines[i].text);
    if (!key) continue;
    if (key.startsWith("status_line_provider.")) {
      throw new UnsupportedConfig(`line ${i + 1}: status_line_provider is written with dotted keys`);
    }
    if (key === "status_line_provider") idx = i;
  }
  if (idx >= 0 && idx + 1 < lines.length && !lines[idx + 1].top) {
    throw new UnsupportedConfig(`line ${idx + 1}: status_line_provider spans several lines`);
  }
  if (on) {
    if (idx >= 0) out[idx] = PROVIDER_LINE + cr;
    else out.splice(start + 1, 0, PROVIDER_LINE + cr);
  } else if (idx >= 0 && isOurProvider(out[idx])) {
    out.splice(idx, 1);
  }
  return out.join("\n");
}

// The status_line_provider value set in [tui] (comment stripped), or null. Never throws.
export function readProvider(toml) {
  let inTui = false;
  for (const l of scanLines(toml)) {
    if (!l.top) continue;
    if (/^\s*\[/.test(l.text)) {
      const name = headerName(l.text);
      if (name === "tui.status_line_provider") return "[tui.status_line_provider] table";
      inTui = name === "tui";
    } else if (inTui && keyOf(l.text) === "status_line_provider") {
      return codePart(l.text).trim();
    }
  }
  return null;
}

// ---- installer ----

// True when config.toml itself defines the codex-hud MCP server ([mcp_servers.codex-hud],
// a codex-hud key under [mcp_servers], root dotted keys, or a root inline table). `codex mcp get` cannot tell:
// it also reports servers supplied by installed plugins.
export function configHasServer(toml) {
  const lines = scanLines(toml || "");
  let table = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.top) continue;
    if (/^\s*\[/.test(l.text)) {
      table = headerName(l.text) || "";
      if (table === `mcp_servers.${NAME}` || table.startsWith(`mcp_servers.${NAME}.`)) return true;
      continue;
    }
    const code = l.code.trimStart();
    const assignment = ASSIGNMENT.exec(code);
    if (!assignment) continue;
    const key = keyPath(assignment[1]);
    const full = table ? `${table}.${key}` : key;
    if (full === `mcp_servers.${NAME}` || full.startsWith(`mcp_servers.${NAME}.`)) return true;
    if (!table && key === "mcp_servers") {
      const value = [code.slice(assignment[0].length)];
      while (i + 1 < lines.length && !lines[i + 1].top) value.push(lines[++i].code);
      for (const [field] of inlineFields(value.join("\n").trim())) {
        if (field === NAME || field.startsWith(`${NAME}.`)) return true;
      }
    }
  }
  return false;
}

// "codex-hud@<marketplace>" when the plugin is installed and enabled, else null.
// Takes `codex plugin list --json` output (plain `codex plugin list` also prints the remote
// catalogue, megabytes long); the text listing is accepted as a fallback.
export const PLUGIN_LIST_ARGS = Object.freeze(["plugin", "list", "--json"]);

export function pluginInstalled(output) {
  if (!output) return null;
  try {
    const data = JSON.parse(output);
    const hit = (Array.isArray(data.installed) ? data.installed : []).find(
      (p) => p && p.name === NAME && p.installed !== false && p.enabled !== false,
    );
    return hit ? String(hit.pluginId || `${NAME}@${hit.marketplaceName}`) : null;
  } catch {
    const m = new RegExp(`^\\s*(${NAME}@\\S+)\\s+installed, enabled\\b`, "m").exec(output);
    return m ? m[1] : null;
  }
}

function quiet(...a) {
  try {
    return execFileSync("codex", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");
  const select = !args.includes("--no-select");
  const configFile = join(codexHome(), "config.toml");
  let backupFile = null;

  const codex = (...a) => {
    console.log(`$ codex ${a.join(" ")}`);
    if (!dry) execFileSync("codex", a, { stdio: ["ignore", "inherit", "inherit"] });
  };

  // Write to a temp file in the same directory, then rename: never a half-written config.
  const writeAtomic = (content, mode = 0o600) => {
    const tmp = `${configFile}.${NAME}-${process.pid}.tmp`;
    try {
      writeFileSync(tmp, content, { mode });
      chmodSync(tmp, mode);
      renameSync(tmp, configFile);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw e;
    }
  };

  const editConfig = (on) => {
    const before = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
    const after = setProvider(before, on);
    if (after === before) return;
    console.log(`${on ? "select" : "unselect"} provider in ${configFile} [tui]`);
    if (!dry) writeAtomic(after, existsSync(configFile) ? statSync(configFile).mode & 0o777 : 0o600);
  };

  // Codex refuses to start on an unreadable config; check with Codex itself and roll back.
  const verify = () => {
    if (dry) return;
    try {
      execFileSync("codex", ["features", "list"], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      throw new Error(`Codex cannot load ${configFile} after the change:\n${e.stderr || e.message}`, { cause: e });
    }
  };

  const features = quiet("features", "list");
  if (features === null) {
    console.error("`codex features list` failed: is codex on PATH and is config.toml valid?");
    process.exit(1);
  }
  if (!uninstall && !features.includes(FEATURE)) {
    console.error(`This Codex build has no "${FEATURE}" feature. Upgrade Codex (0.171+ is known to work).`);
    process.exit(1);
  }
  // Installed as a Codex plugin already: a second "codex-hud" server would make the
  // provider selection ambiguous.
  if (!uninstall) {
    const plugin = pluginInstalled(quiet(...PLUGIN_LIST_ARGS));
    if (plugin) {
      console.error(`codex-hud is already installed as the plugin ${plugin}.`);
      console.error(`Enable the feature and pick it in /statusline instead:\n  codex features enable ${FEATURE}`);
      console.error(`Or remove the plugin first: codex plugin remove ${plugin}`);
      process.exit(1);
    }
  }
  // Check the [tui] edit is possible before touching anything.
  if (select && !uninstall) {
    try {
      setProvider(existsSync(configFile) ? readFileSync(configFile, "utf8") : "", true);
    } catch (e) {
      if (!(e instanceof UnsupportedConfig)) throw e;
      console.error(`Cannot edit ${configFile} safely: ${e.message}.`);
      console.error(
        `Rerun with --no-select and pick codex-hud in /statusline instead, or set by hand under [tui]:\n  ${PROVIDER_LINE}`,
      );
      process.exit(1);
    }
  }
  const hadConfig = existsSync(configFile);
  const originalMode = hadConfig ? statSync(configFile).mode & 0o777 : 0o600;
  if (hadConfig && !dry) {
    backupFile = `${configFile}.before-${NAME}.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(configFile, backupFile);
    console.log(`backup: ${backupFile}`);
  }
  try {
    if (uninstall) {
      const registered = configHasServer(hadConfig ? readFileSync(configFile, "utf8") : "");
      try {
        editConfig(false);
      } catch (e) {
        if (!(e instanceof UnsupportedConfig)) throw e;
        console.warn(`Left [tui] untouched (${e.message}). If it selects codex-hud, pick another provider in /statusline.`);
      }
      if (registered) codex("mcp", "remove", NAME);
    } else {
      codex("features", "enable", FEATURE);
      const env = [];
      for (const key of ["CODEX_HOME", "CODEX_HUD_CONFIG", "XDG_CONFIG_HOME", "CODEX_HUD_DISABLE"]) {
        if (process.env[key]) env.push("--env", `${key}=${process.env[key]}`);
      }
      // mcp add replaces a same-name registration in a single config update.
      codex("mcp", "add", NAME, ...env, "--", ...launchCommand());
      if (select) editConfig(true);
    }
    verify();
  } catch (e) {
    console.error(`codex-hud: ${e.message}`);
    if (!dry) {
      try {
        if (backupFile) {
          writeAtomic(readFileSync(backupFile), originalMode);
          console.error(`Restored ${configFile} from ${backupFile}.`);
        } else if (!hadConfig) {
          rmSync(configFile, { force: true });
        }
      } catch (rollbackError) {
        console.error(`Could not restore ${configFile}: ${rollbackError.message}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  if (uninstall) {
    console.log(`\nRemoved. The "${FEATURE}" feature is left on; disable it with: codex features disable ${FEATURE}`);
    return;
  }

  console.log(`
Done. Restart Codex (new TUI session) to see the HUD.
${select ? "" : "Then open /statusline → Choose a status line provider → codex-hud.\n"}Preview without Codex:  node ${HUD} --preview
Check the setup:         node ${HUD} --doctor
Config (optional):       ${configPath()}
Back to the built-in footer: /statusline → Choose a status line provider → Default`);
  if (MANAGED_NODE.test(process.execPath)) {
    console.log(`
Note: registered ${process.execPath}, which belongs to a Node version manager.
If you remove that Node version, rerun this script with the Node you switch to.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
