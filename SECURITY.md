# Security Policy

## Scope and Architecture

`codex-hud` runs locally as a child stdio MCP server spawned by the Codex CLI. It has **zero third-party runtime dependencies** and makes **no network requests**.

Its local side effects and inputs are strictly bounded:

- **Read-only statusline provider (`hud.mjs`)**:
  - Reads JSON-RPC requests from `stdin` and writes UI tree JSON responses to `stdout`.
  - Reads user configuration from `CODEX_HUD_CONFIG` or `~/.config/codex-hud/config.json` (capped at 64 KiB; unknown or mistyped fields are ignored and numbers are clamped).
  - Runs `git --no-optional-locks status --porcelain=v1 --branch --untracked-files=normal` via `execFile` (no shell interpolation, 800 ms timeout) in the active thread's `workspace.cwd`.
  - Reads the tail of the current thread's rollout file under `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` with bounded read sizes (`2 MiB` initial tail, `4 MiB` max per poll, `1 MiB` max line length).
  - Reads `~/.codex/models_cache.json` for context-window sizes, and, when the snapshot has no rate limits, the last `128 KiB` of up to 30 of the newest rollout files (from any thread) for the latest rate-limit event.
  - Strips control characters and Unicode bidirectional overrides from untrusted strings (such as thread titles, plan steps, and shell commands) before rendering.
- **Installer (`install.mjs`)**:
  - Edits `[tui]` in `~/.codex/config.toml` only when the section layout can be modified unambiguously; otherwise it aborts with `UnsupportedConfig` before touching any file.
  - Writes a timestamped backup (`config.toml.before-codex-hud.<timestamp>`), edits `config.toml` atomically via a temporary file in the same directory while preserving file permissions, and verifies the result with `codex features list`. If an installation or removal step fails, it restores the backup or removes the config created by that run.

## Supported Versions

Security fixes are applied to the latest version on the `main` branch (Node.js 18+).

## Reporting a Vulnerability

If you discover a security issue (for example, unsafe command execution, arbitrary file overwrite in `install.mjs`, or unbounded memory growth when parsing rollout files):

1. Please use GitHub's **Report a vulnerability** (Private Vulnerability Reporting) tab on the repository if enabled, or contact the maintainer privately before opening a public issue.
2. Include a minimal reproduction (sample `config.toml`, snapshot JSON, or rollout JSONL line) and your OS / Node.js / Codex CLI versions.
