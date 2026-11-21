# codex-hud: Codex CLI Status-Line HUD

**English** | [简体中文](README_CN.md)

`codex-hud` is a compact status-line HUD for the Codex CLI, inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud) and [agy-hud](https://github.com/franksde/agy-hud). It renders in the Codex TUI footer and needs only Node.js 18+; there is no `npm install` step.

**Default status line (`"icons": false`)**

```text
gpt-5.5 high │ codex-hud │ ⎇ main* +1~2?1 ↑1   Context ███░░░░░ 43% 172k/400k │ Usage 5h ██░░░░░░ 23% ↻1h51m  7d ██████░░ ! 74% ↻3d5h
```

When the terminal is too narrow for one line, the footer wraps between the two groups, so `Context` and `Usage` start the second line.

The default shows the model and project names as text and uses Unicode symbols such as `⎇` and `↻`. For model and folder icons, see [Icons Render As Boxes](#icons-render-as-boxes).

## Requirements

- **Codex CLI 0.171.0 or newer** with the experimental `tui_extensions_statusline` feature.
- **Node.js 18+** (see [Node Is Not Found](#node-is-not-found)).
- **macOS, Linux, WSL, or Windows**.
- **A Nerd Font (optional)**. The default `"icons": false` uses plain Unicode and works with any font. `"icons": true` needs a Nerd Font in your terminal.

## Installation

Choose one method. `install.mjs` refuses to run when the Codex plugin is installed, and `--doctor` flags a duplicate registration.

### Option 1: Codex Plugin (macOS / Linux / WSL)

This repository is also a Codex plugin marketplace:

```sh
codex plugin marketplace add zhshj0110/codex-hud   # or a local clone: codex plugin marketplace add ~/codex-hud
codex plugin add codex-hud@codex-hud
codex features enable tui_extensions_statusline
```

Then start Codex and pick the provider once:

```text
/statusline → Choose a status line provider → codex-hud · codex-hud@codex-hud
```

A plugin cannot enable the feature or select itself, so these steps are manual.

The plugin runs `node ./hud.mjs`, so `node` must be on the `PATH` Codex starts with. If it isn't, use Option 2. The plugin has not been tested on Windows; use Option 2 there too.

### Option 2: Install Script (All Platforms, Including Windows)

```sh
git clone https://github.com/zhshj0110/codex-hud.git ~/codex-hud
node ~/codex-hud/install.mjs
```

On Windows (PowerShell or `cmd.exe`):

```powershell
git clone https://github.com/zhshj0110/codex-hud.git "$HOME\codex-hud"
node "$HOME\codex-hud\install.mjs"
```

The installer backs up `config.toml` to `config.toml.before-codex-hud.<timestamp>`, then:

1. Runs `codex features enable tui_extensions_statusline`.
2. Registers the `codex-hud` MCP server as `<node> <clone>/hud.mjs`, where `<node>` is the absolute path of the Node.js running the script, so Codex's minimal `PATH` does not need to contain `node`. To register a different Node, run the script with it, e.g. `/opt/homebrew/bin/node ~/codex-hud/install.mjs`.
3. Writes `status_line_provider = { server = "codex-hud", tool = "statusline" }` under `[tui]`. Pass `--no-select` if you prefer to choose it manually in `/statusline`.

If a step fails, the installer restores the backup. If `[tui]` uses a layout it can't edit (a `[tui.status_line_provider]` subtable, top-level `tui.xxx =` dotted keys, or a multi-line `status_line_provider`), it stops without changing anything. Rerun with `--no-select` and pick `codex-hud` in `/statusline`.

Start a new Codex session to see the HUD.

## Upgrading

- **Codex plugin (Git marketplace):**

  ```sh
  codex plugin marketplace upgrade codex-hud
  codex plugin add codex-hud@codex-hud
  ```

- **Install script (local clone):**

  ```sh
  cd ~/codex-hud && git pull
  ```

  The registered server runs `hud.mjs` from your clone, so updates apply on the next Codex session. Rerun `install.mjs` only if you changed variables such as `CODEX_HOME` or removed the Node version it registered.

Your [config file](#config) lives outside the repository, so upgrades leave it alone.

## Uninstalling

- **Codex plugin:**

  ```sh
  codex plugin remove codex-hud@codex-hud
  codex plugin marketplace remove codex-hud   # optional
  ```

  Then switch back in Codex: `/statusline → Choose a status line provider → Default status line`.

- **Install script:**

  ```sh
  node ~/codex-hud/install.mjs --uninstall
  ```

  This removes both the `codex-hud` MCP server entry and the `[tui] status_line_provider` selection from `config.toml`.

- **Temporarily hiding the footer (keeping your provider selection):**
  - Plugin users: set `CODEX_HUD_DISABLE=1` before launching Codex.
  - Install-script users: run `CODEX_HUD_DISABLE=1 node ~/codex-hud/install.mjs --no-select`, then restart Codex.
  - To re-enable, unset `CODEX_HUD_DISABLE` (and rerun `install.mjs --no-select` if you used the install script).

## Icons Render As Boxes

With `"icons": true`, `codex-hud` uses Nerd Font glyphs for `model`, `folder`, `branch`, `mode`, `tools`, `plan`, `edit`, `clock`, `reset`, and `fast`. A font without them shows boxes or `?`.

Run the diagnostic in the terminal you use for Codex:

```sh
node hud.mjs --doctor
```

It prints a plain Unicode row and a Nerd Font row. The terminal can't report which glyphs it drew, so check the `nerd` row by eye. If it shows boxes, `?`, or blanks, either:

**A. Use plain Unicode.** Set `"icons": false` in your [config file](#config) and keep its other keys. If you have no config file yet:

```sh
mkdir -p ~/.config/codex-hud
echo '{"icons": false}' > ~/.config/codex-hud/config.json
```

On Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force -Path "~\.config\codex-hud" | Out-Null
Set-Content -Encoding ascii -Path "~\.config\codex-hud\config.json" -Value '{"icons": false}'
```

**B. Enable Nerd Font icons.**

1. Install a Nerd Font — for example `brew install --cask font-hack-nerd-font` on macOS, or Hack Nerd Font from <https://www.nerdfonts.com> on Windows.
2. Point your terminal profile at that font family (e.g., iTerm2 → Settings → Profiles → Text → Font, VS Code `terminal.integrated.fontFamily`, `font-family` in `~/.config/ghostty/config`, or Windows Terminal → Settings → Profiles → Defaults → Appearance → Font face). Ghostty, WezTerm, and kitty include Nerd Font symbol fallbacks.
3. Set `"icons": true` in your [config file](#config).

<img src="assets/preview.png" alt="Codex status line with Nerd Font icons enabled" width="700">

Over SSH, your local terminal draws the glyphs, so a font installed on the remote host has no effect.

## Node Is Not Found

Codex starts MCP servers with a minimal environment (`HOME` and `PATH`, without loading `.zshrc` or `.bashrc`).

**Install script.** The server is registered with the absolute path of the `node` that ran `install.mjs`, so `PATH` does not matter. If that `node` came from a version manager (nvm, fnm, Volta, mise, asdf, nodenv, or n), removing that Node version breaks the footer. Rerun `install.mjs` with the Node you switched to, or register one outside any version manager:

```sh
/opt/homebrew/bin/node ~/codex-hud/install.mjs   # or /usr/local/bin/node, /usr/bin/node, ...
```

`node hud.mjs --doctor` warns when the registered Node belongs to a version manager or no longer exists.

**Codex plugin.** The plugin runs `node ./hud.mjs`, so `node` must be on the `PATH` Codex starts with. Otherwise the server fails to start (press `F2` in Codex to see the error); use the install script instead.

Check what is registered:

```sh
codex mcp get codex-hud
```

## For AI Agents

Steps for an agent installing or troubleshooting `codex-hud` for a user:

1. **Check existing state.** Run `node hud.mjs --doctor --json` if the repo is present, or check `~/.codex/config.toml` and `codex plugin list`. Use only one install method.
2. **Confirm preferences.** Show the user the [default status line](#codex-hud-codex-cli-status-line-hud) and ask whether they want different [`segments`](#config) or Nerd Font icons.
   - Icons: have the user run `node hud.mjs --doctor` in the terminal they use for Codex and tell you whether the `nerd` row renders. Agents can't detect this.
   - Install a font only if the user asks. Installing one doesn't change the terminal's font setting and has no effect over SSH.
3. **Install.**
   - macOS / Linux / WSL: the Codex plugin (`codex plugin marketplace add zhshj0110/codex-hud && codex plugin add codex-hud@codex-hud && codex features enable tui_extensions_statusline`, then the user selects it in `/statusline`), or `node install.mjs`, which also enables the feature and selects the provider.
   - Windows: `node install.mjs`.
   - If `install.mjs` stops on an unsupported `[tui]` layout, show the user the error, run `node install.mjs --no-select`, and have them select `codex-hud` in `/statusline`.
4. **Verify** with `node hud.mjs --doctor --json`. Example output:

```json
{
  "version": "0.1.0",
  "ok": true,
  "counts": { "ok": 7, "warn": 0, "fail": 0 },
  "checks": [
    { "id": "node", "title": "Node.js", "status": "ok", "summary": "v22.14.0 (...)" },
    { "id": "codex", "title": "Codex CLI", "status": "ok", "summary": "codex-cli 0.171.0 (...)" },
    { "id": "feature", "title": "Statusline feature", "status": "ok", "summary": "tui_extensions_statusline (experimental) enabled" },
    { "id": "mcp", "title": "MCP server", "status": "ok", "summary": ".../bin/node .../codex-hud/hud.mjs" },
    { "id": "provider", "title": "[tui] provider", "status": "ok", "summary": "status_line_provider = { server = \"codex-hud\", tool = \"statusline\" }" },
    { "id": "config", "title": "User config", "status": "ok", "summary": "~/.config/codex-hud/config.json (default) is valid" },
    { "id": "render", "title": "Render limits", "status": "ok", "summary": "sample: ...; worst case: ..." }
  ],
  "icons": { "enabled": false, "plain": "...", "nerd": "..." },
  "preview": { "line": "...", "limits": { "ok": true } }
}
```

Act on each check:
- `node` (`fail`): Node.js is older than 18; report it.
- `codex` / `feature` (`fail` / `warn`): Codex CLI is missing, predates `tui_extensions_statusline`, or the feature is disabled (`codex features enable tui_extensions_statusline`).
- `mcp` (`warn`): server is missing, disabled, registered twice (both plugin and `config.toml`), points at a file that no longer exists, or uses a version-manager Node. Follow the check's `hint`.
- `provider` (`warn`): `[tui] status_line_provider` is unset or points to another provider. If another provider is selected, tell the user before changing it; for plugin installs, remind the user to pick `codex-hud` in `/statusline`.
- `config` (`warn`): invalid JSON, oversized (> 64 KiB), or unknown/mistyped keys. Merge fixes carefully rather than overwriting user settings.
- `disabled` (`warn`): `CODEX_HUD_DISABLE=1` is set in this environment, so the footer would be empty. Ask the user whether that is intended before unsetting it.
- `render` (`fail`): UI tree exceeded Codex's protocol limits.

## CLI

```sh
node install.mjs --dry-run                          # Preview config.toml changes without modifying anything
node install.mjs --no-select                        # Register MCP server without editing [tui] status_line_provider
node install.mjs --uninstall                        # Remove MCP server registration and provider selection

node hud.mjs --version                              # Print codex-hud version
node hud.mjs --preview                              # Render a sample snapshot in the terminal (or: npm run preview)
node hud.mjs --preview --theme dracula              # Preview with a specific theme (e.g. dracula, one-half-light)
node hud.mjs --preview --state snapshot.json --json # Render a custom snapshot and print the UI tree JSON
node hud.mjs --doctor                               # Run full diagnostics + icon probe (or: npm run doctor)
node hud.mjs --doctor --json                        # Machine-readable JSON diagnostics
```

`--doctor` is read-only. It checks the items listed under [For AI Agents](#for-ai-agents), prints the icon probe, and renders sample and worst-case lines against Codex's UI tree limits.

## How It Works

Codex 0.171 added the experimental `tui_extensions_statusline` feature, in which an MCP server provides the status line. (`claude-hud` and `agy-hud` instead run a shell command that reads JSON on stdin and prints a line.)

1. The provider is a stdio MCP server that advertises a tool in `tools/list` with
   `_meta["openai/ui"].entrypoints = [{ type: "statusline", resourceUri: "ui://codex-hud/footer" }]`.
2. Once selected via `/statusline → Choose a status line provider` (saved under `[tui]` as `status_line_provider` in `config.toml`), Codex polls `resources/read` on that URI roughly once per second, passing a snapshot of the active thread in `params._meta["com.openai/codex-statusline-state"]`: model, reasoning effort, permissions & approval mode, thread title, cwd, context usage, cumulative tokens & cache hit rate, rate limits, cost, agent state, and more.
3. The provider returns a JSON UI tree (`row`, `text`, `bold`, `link`, etc., with `status-*` theme colors) that Codex renders natively. Protocol limits: 64 KiB JSON, 256 nodes, depth 16, 16 KiB text, and a 1-second timeout per read. Errors or timeouts stop polling until you re-select the provider in `/statusline`.

The protocol is documented in the `create-statusline` skill built into the Codex binary.

The plugin's `.mcp.json` forwards `HOME`, `PATH`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `CODEX_HUD_CONFIG`, and `CODEX_HUD_DISABLE` to the server. Other variables are not passed through.

Besides the snapshot, `codex-hud` reads these local sources:

| Segment | Source |
| --- | --- |
| `model` / `mode` (permissions, approval, profile) / `title` (optional) / `context` / `tokens` (input/output & cache rate) / `limits` (5h & 7d) / `cost` / `state` | Snapshot (`com.openai/codex-statusline-state`) |
| `project` (directory name + git branch, dirty, staged/modified/untracked counts, ahead/behind) | `git status --porcelain --branch`, cached for 2 s with background refresh |
| `env` (`AGENTS.md`, MCP server, and skill counts) | Scans `cwd` and `~/.codex` config/directories, cached for 30 s with background refresh |
| `tools` (plan progress & current step, running `◐` vs completed `⚙` tools, last command), `session` (elapsed duration, turns `#N`, patched files `✎ N`) & turn duration in `state` | Incremental reader on `~/.codex/sessions/**/rollout-*-<thread-id>.jsonl` |
| `context` window size when the snapshot lacks it | `~/.codex/models_cache.json`, cached for 60 s |
| `limits` when the snapshot carries no rate limits | Last 128 KiB of up to 30 of the newest rollout files under `~/.codex/sessions/` (any thread), cached for 30 s |

## Config

`codex-hud` resolves its configuration file in order:

1. `CODEX_HUD_CONFIG`
2. `$XDG_CONFIG_HOME/codex-hud/config.json`
3. `~/.config/codex-hud/config.json`

Changes apply within 5 seconds without a restart. See [`config.example.json`](./config.example.json).

Default config:

```json
{
  "segments": ["model", "project", "context", "limits", "cost"],
  "groups": [["model", "project"], ["context", "limits", "cost"]],
  "barWidth": 8,
  "icons": false,
  "allLimits": false,
  "showGitCounts": true,
  "showCacheRate": true,
  "showLastCommand": true,
  "showPlanCurrent": true,
  "maxTools": 3,
  "lastCommandWidth": 32,
  "planCurrentWidth": 24,
  "titleWidth": 32,
  "warn": 70,
  "danger": 90
}
```

Options:

- `segments`: Ordered list of segments to display; omit any segment to hide it. Available segments: `model`, `mode`, `title`, `project`, `context`, `tokens`, `limits`, `cost`, `env`, `tools`, `session`, `state`. `mode`, `title`, `tokens`, `env`, `tools`, `session`, and `state` are off by default — add them to `segments` to enable them.
- `groups`: Segments that stay together when the footer wraps (default `[["model", "project"], ["context", "limits", "cost"]]`). It replaces `segments`; setting `segments` without `groups`, or `"groups": null`, turns grouping off. Groups are spaced apart with no `│` between them. Codex wraps only when it runs out of width, so a wide terminal still shows one line; a narrow one breaks between groups, and inside a group only if that group alone is wider than the terminal. Codex has no line-break element for providers, so a fixed two-line layout is not possible.
- `barWidth`: Progress bar width (1–40, default `8`).
- `icons`: Use Nerd Font glyphs instead of plain Unicode (default `false`).
- `allLimits`: Show all rate-limit buckets instead of only the primary `codex` bucket (default `false`).
- `showGitCounts`: Show staged (`+`), modified (`~`), and untracked (`?`) file counts next to the git branch (default `true`).
- `showCacheRate`: Show prompt cache hit percentage in the `tokens` segment (default `true`).
- `showLastCommand` / `lastCommandWidth`: Show the last shell command of the current turn at the end of `tools` and its max width (4–200, default `true` / `32`).
- `showPlanCurrent` / `planCurrentWidth`: When `update_plan` progress exists, show the current `in_progress` step next to `☑ done/total` and its max width (4–200, default `true` / `24`).
- `titleWidth`: Max character width for the `title` segment (4–200, default `32`); newlines and control characters are stripped.
- `maxTools`: Max distinct tools shown for running (`◐`) and completed (`⚙`) groups respectively (1–10, default `3`).
- `warn` / `danger`: Percentage thresholds for yellow (`!`) and red (`!!`) meter alerts (default `70` / `90`).

Fields with the wrong type use their defaults, numeric settings are clamped to their ranges, and unknown `segments` entries are skipped.

## Colors & Themes

- Normal state uses `status-*` theme colors and the default foreground, so the footer follows `/theme`.
- Meters use their segment theme color (`status-usage` / `status-limit`) for the label and bar, with a bold default-foreground percentage:
  - At `warn`: the bar turns ANSI yellow and `!` is prefixed to the percentage.
  - At `danger`: the bar turns ANSI red and `!!` is prefixed to the percentage.
  - Alert colors come from the terminal's ANSI palette, not the theme. The `!`/`!!` markers matter because some themes already use amber or red in normal state (e.g. `status-limit` in `one-half-light`).
  - Thresholds apply to the rounded displayed value (`69.6%` renders as `! 70%`).
  - To turn alerts off, set both `warn` and `danger` to `101`.
- The `state` segment shows `◌` for waiting and `●` for working.
- The "Use theme colors" toggle in `/statusline` does not affect custom providers.

Preview different themes locally: `node hud.mjs --preview --theme dracula` or `--theme one-half-light`.

## Privacy And Security

`codex-hud` runs locally as a stdio MCP server started by Codex. It has no third-party runtime dependencies and makes no network requests.

- `hud.mjs` is read-only: it reads JSON-RPC requests from `stdin`, local config (`<= 64 KiB`), git status via `execFile` (no shell interpolation, 800 ms timeout), bounded tails of the active thread's rollout file under `~/.codex/sessions/`, `~/.codex/models_cache.json`, and, for the rate-limit fallback, the last 128 KiB of up to 30 recent rollout files from any thread.
- Control characters and Unicode bidirectional overrides are stripped from untrusted strings (thread titles, plan steps, shell commands) before rendering.
- `node hud.mjs --doctor` only reads local files and runs read-only `codex` subcommands (`--version`, `features list`, `mcp get`, `plugin list`). `--doctor --json` output includes absolute local paths, so check it before pasting it into a public issue.
- See [SECURITY.md](./SECURITY.md) for the full security model and vulnerability reporting instructions.

## Development

```sh
npm test
npm run preview
npm run doctor
```

No build step is required. See [CONTRIBUTING.md](./CONTRIBUTING.md) for development workflow and testing guidelines. Licensed under the [MIT License](./LICENSE).
