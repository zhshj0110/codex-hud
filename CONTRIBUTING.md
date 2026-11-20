# Contributing to codex-hud

`codex-hud` is a zero-dependency status line provider for the Codex CLI TUI, implemented as a stdio MCP server on Node.js 18+.

## Design Constraints

Every change must preserve the following invariants:

1. **Zero external runtime dependencies**: Use only Node.js built-in modules (`node:fs`, `node:child_process`, `node:readline`, `node:test`, etc.).
2. **Node.js 18+ compatibility**: Do not rely on APIs introduced after Node 18.
3. **Codex statusline UI tree limits**: Every response from `resources/read` must fit within Codex's hard limits (`64 KiB` JSON, `256` nodes, depth `16`, `16 KiB` text). If a tree exceeds the limits, `renderSafe` falls back to `["model", "context"]`, then `null`.
4. **1-second poll budget**: Codex gives each `resources/read` call 1 second and stops polling on timeout or error. Local I/O (config reload, `git status`, rollout file tailing) is bounded by `LOCAL_BUDGET_MS` (300 ms) and cached/incremental so slow disk or git operations never block a poll.
5. **Safe fallbacks**: Malformed snapshot fields, corrupt rollout lines, or invalid user `config.json` files must degrade gracefully to defaults without throwing or blanking the entire footer.

## Project Layout

- `hud.mjs` — stdio MCP server entrypoint, `--preview`, and `--doctor` CLI flags.
- `install.mjs` — section-aware TOML editor and installer/uninstaller for `~/.codex/config.toml`.
- `src/config.mjs` — config schema, `DEFAULTS`, range clamping, and 5-second cached loader.
- `src/render.mjs` — snapshot + local data to Codex UI tree renderer, theme-aware ANSI preview (`toAnsi`), and `checkLimits`.
- `src/git.mjs` — non-locking `git status --porcelain=v1 --branch` parser with a 2-second LRU cache.
- `src/transcript.mjs` — incremental byte-bounded rollout JSONL follower (`TranscriptWatcher`) tracking turn elapsed time, plan steps (`done/total` and `current`), running vs. completed tool calls, and the last shell command.
- `src/doctor.mjs` — diagnostic checks (`node hud.mjs --doctor [--json]`).
- `test/*.test.mjs` — unit and integration test suites using `node:test`.

## Development Workflow

```bash
# Run the test suite
npm test

# Preview the status line in your terminal with the sample snapshot
npm run preview
node hud.mjs --preview --theme one-half-light

# Run diagnostics
npm run doctor
node hud.mjs --doctor --json
```

When adding or changing a configuration option in `src/config.mjs`, keep `config.example.json`, `README.md`, `README_CN.md`, and the unit tests in sync.
