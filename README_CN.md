# codex-hud: Codex CLI 状态栏 HUD

[English](README.md) | **简体中文**

`codex-hud` 是一个给 Codex CLI 使用的紧凑型状态栏 HUD，思路参考 [claude-hud](https://github.com/jarrodwatts/claude-hud) 和 [agy-hud](https://github.com/franksde/agy-hud)。它在 Codex TUI 的 footer 里渲染，只需要 Node.js 18+，不用执行 `npm install`。

**默认状态栏（`"icons": false`）**

```text
gpt-5.5 high │ codex-hud │ ⎇ main* +1~2?1 ↑1   Context ███░░░░░ 43% 172k/400k │ Usage 5h ██░░░░░░ 23% ↻1h51m  7d ██████░░ ! 74% ↻3d5h
```

终端宽度不够一行时，footer 会在两组之间折行，`Context` 和 `Usage` 从第二行开始。

默认以纯文字显示模型和项目名，并使用 `⎇`、`↻` 等 Unicode 符号。模型和文件夹图标见[图标显示成方块](#图标显示成方块)。

## 运行要求

- **Codex CLI 0.171.0 或更高版本**，并开启实验特性 `tui_extensions_statusline`。
- **Node.js 18+**（见[找不到 Node](#找不到-node)）。
- **macOS、Linux、WSL 或 Windows**。
- **Nerd Font 字体（可选）**。默认 `"icons": false` 使用纯 Unicode，任何字体都能显示。`"icons": true` 需要终端配置 Nerd Font。

## 安装

两种方式选一种。已装 Codex 插件时 `install.mjs` 会拒绝执行，重复注册时 `--doctor` 会报出来。

### 方式一：Codex 插件（macOS / Linux / WSL）

本仓库本身也是一个 Codex 插件 marketplace：

```sh
codex plugin marketplace add zhshj0110/codex-hud   # 或本地 clone：codex plugin marketplace add ~/codex-hud
codex plugin add codex-hud@codex-hud
codex features enable tui_extensions_statusline
```

然后启动 Codex，选中一次 provider：

```text
/statusline → Choose a status line provider → codex-hud · codex-hud@codex-hud
```

插件不能自己开启特性，也不能把自己设为 provider，所以这两步要手动做。

插件运行 `node ./hud.mjs`，Codex 启动时的 `PATH` 上要有 `node`，否则请用方式二。插件方式没在 Windows 上测过，Windows 也请用方式二。

### 方式二：安装脚本（全平台，含 Windows）

```sh
git clone https://github.com/zhshj0110/codex-hud.git ~/codex-hud
node ~/codex-hud/install.mjs
```

Windows（PowerShell 或 `cmd.exe`）：

```powershell
git clone https://github.com/zhshj0110/codex-hud.git "$HOME\codex-hud"
node "$HOME\codex-hud\install.mjs"
```

安装脚本会先把 `config.toml` 备份为 `config.toml.before-codex-hud.<时间>`，然后：

1. 执行 `codex features enable tui_extensions_statusline`。
2. 注册 `codex-hud` MCP server，命令为 `<node> <仓库>/hud.mjs`，其中 `<node>` 是运行安装脚本的 Node.js 的绝对路径，因此 Codex 的精简 `PATH` 里不需要有 `node`。如需注册另一个 Node，用它来运行脚本即可，例如 `/opt/homebrew/bin/node ~/codex-hud/install.mjs`。
3. 在 `[tui]` 下写入 `status_line_provider = { server = "codex-hud", tool = "statusline" }`。如果希望之后自己在 `/statusline` 里选择，可加 `--no-select`。

某一步失败时，脚本会从备份恢复。如果 `[tui]` 的写法它改不了（`[tui.status_line_provider]` 子表、顶层 `tui.xxx =` 点号键、多行的 `status_line_provider`），脚本不做任何改动直接退出。此时加 `--no-select` 重跑，再到 `/statusline` 里选中 `codex-hud`。

装好后重开一个 Codex 会话即可看到状态栏。

## 升级

- **Codex 插件（Git marketplace）：**

  ```sh
  codex plugin marketplace upgrade codex-hud
  codex plugin add codex-hud@codex-hud
  ```

- **安装脚本（本地 clone）：**

  ```sh
  cd ~/codex-hud && git pull
  ```

  注册的 server 直接运行本地仓库里的 `hud.mjs`，拉取后重开 Codex 会话即生效。只有改了 `CODEX_HOME` 等变量，或卸载了注册时用的 Node 版本，才需要重跑 `install.mjs`。

[配置文件](#配置)不在仓库里，升级不会动它。

## 卸载

- **Codex 插件：**

  ```sh
  codex plugin remove codex-hud@codex-hud
  codex plugin marketplace remove codex-hud   # 可选
  ```

  然后在 Codex 中切回内置状态栏：`/statusline → Choose a status line provider → Default status line`。

- **安装脚本：**

  ```sh
  node ~/codex-hud/install.mjs --uninstall
  ```

  该命令会一并移除 `config.toml` 中的 `codex-hud` MCP server 注册和 `[tui] status_line_provider` 选择。

- **临时隐藏状态栏（保留 provider 选择）：**
  - 插件用户：启动 Codex 前设置 `CODEX_HUD_DISABLE=1`。
  - 脚本安装用户：运行 `CODEX_HUD_DISABLE=1 node ~/codex-hud/install.mjs --no-select`，然后重启 Codex。
  - 恢复显示时取消 `CODEX_HUD_DISABLE`（脚本安装用户再运行一次 `install.mjs --no-select`）。

## 图标显示成方块

开启 `"icons": true` 后，`model`、`folder`、`branch`、`mode`、`tools`、`plan`、`edit`、`clock`、`reset` 和 `fast` 会使用 Nerd Font 字形。字体里没有这些字形时，会显示成方块或 `?`。

在你运行 Codex 的终端里执行诊断：

```sh
node hud.mjs --doctor
```

它会打印纯 Unicode 和 Nerd Font 两行。终端不会回报实际画出了什么字形，所以要自己看 `nerd` 那一行。如果显示方块、`?` 或空白，二选一：

**A. 用纯 Unicode。** 在[配置文件](#配置)里设置 `"icons": false`，保留其他键。还没有配置文件时：

```sh
mkdir -p ~/.config/codex-hud
echo '{"icons": false}' > ~/.config/codex-hud/config.json
```

Windows（PowerShell）：

```powershell
New-Item -ItemType Directory -Force -Path "~\.config\codex-hud" | Out-Null
Set-Content -Encoding ascii -Path "~\.config\codex-hud\config.json" -Value '{"icons": false}'
```

**B. 开启 Nerd Font 图标。**

1. 安装 Nerd Font，例如 macOS 上运行 `brew install --cask font-hack-nerd-font`，Windows 上从 <https://www.nerdfonts.com> 下载 Hack Nerd Font。
2. 把终端 profile 的字体指向该字族（如 iTerm2 → Settings → Profiles → Text → Font、VS Code 的 `terminal.integrated.fontFamily`、`~/.config/ghostty/config` 中的 `font-family`、Windows Terminal → Settings → Profiles → Defaults → Appearance → Font face）。Ghostty、WezTerm、kitty 自带 Nerd Font 符号回退。
3. 在[配置文件](#配置)中设置 `"icons": true`。

<img src="assets/preview.png" alt="开启 Nerd Font 图标后的 Codex 状态栏" width="700">

SSH 下字形由本地终端绘制，在远端主机装字体没有用。

## 找不到 Node

Codex 启动 MCP server 时只传递精简环境（`HOME` 和 `PATH`，不加载 `.zshrc` / `.bashrc`）。

**安装脚本。** server 注册的是运行 `install.mjs` 的 `node` 的绝对路径，与 `PATH` 无关。如果这个 `node` 来自版本管理器（nvm、fnm、Volta、mise、asdf、nodenv 或 n），卸载该版本后状态栏会失效。用新的 Node 重跑 `install.mjs`，或注册一个不属于版本管理器的 Node：

```sh
/opt/homebrew/bin/node ~/codex-hud/install.mjs   # 或 /usr/local/bin/node、/usr/bin/node 等
```

当注册的 Node 属于版本管理器或已不存在时，`node hud.mjs --doctor` 会给出警告。

**Codex 插件。** 插件运行 `node ./hud.mjs`，Codex 启动时的 `PATH` 上要有 `node`，否则 server 启动失败（在 Codex 中按 `F2` 查看错误），这时请改用安装脚本。

查看当前注册的命令：

```sh
codex mcp get codex-hud
```

## 面向 AI Agent

agent 替用户安装或排查 `codex-hud` 时的步骤：

1. **检查现状。** 仓库已在本地时运行 `node hud.mjs --doctor --json`，否则检查 `~/.codex/config.toml` 和 `codex plugin list`。只用一种安装方式。
2. **确认偏好。** 给用户看[默认状态栏](#codex-hud-codex-cli-状态栏-hud)，问是否要调整 [`segments`](#配置) 或开启 Nerd Font 图标。
   - 图标：让用户在运行 Codex 的终端里执行 `node hud.mjs --doctor`，告诉你 `nerd` 行是否正常。agent 无法自行判断。
   - 用户要求时才安装字体。装字体不会改终端的字体设置，SSH 下也没有效果。
3. **安装。**
   - macOS / Linux / WSL：Codex 插件（`codex plugin marketplace add zhshj0110/codex-hud && codex plugin add codex-hud@codex-hud && codex features enable tui_extensions_statusline`，再由用户在 `/statusline` 中选中），或 `node install.mjs`，它会同时开启特性并选中 provider。
   - Windows：`node install.mjs`。
   - `install.mjs` 因 `[tui]` 写法不支持而退出时，把报错给用户看，运行 `node install.mjs --no-select`，再让用户在 `/statusline` 中选中 `codex-hud`。
4. **用 `node hud.mjs --doctor --json` 校验。** 输出示例：

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

按各检查项处理：
- `node`（`fail`）：Node.js 低于 18，如实汇报。
- `codex` / `feature`（`fail` / `warn`）：未找到 Codex CLI、版本过旧不含 `tui_extensions_statusline`，或特性未开启（`codex features enable tui_extensions_statusline`）。
- `mcp`（`warn`）：server 未注册、被禁用、插件与 `config.toml` 重复注册、指向的文件已不存在，或使用了版本管理器中的 Node；按 `hint` 提示修复。
- `provider`（`warn`）：`[tui] status_line_provider` 未设置或指向其他 provider。若已有其他 provider，修改前先告知用户；插件安装时提醒用户在 `/statusline` 中手动选择 `codex-hud`。
- `config`（`warn`）：JSON 语法错误、文件超过 64 KiB，或存在未知/类型错误字段；合并修正而不要覆盖用户已有配置。
- `disabled`（`warn`）：当前环境设置了 `CODEX_HUD_DISABLE=1`，状态栏会是空的。取消设置前先确认这是否是用户有意为之。
- `render`（`fail`）：UI 树超出 Codex 协议限额。

## CLI

```sh
node install.mjs --dry-run                          # 预览 config.toml 改动，不写入任何文件
node install.mjs --no-select                        # 只注册 MCP server，不修改 [tui] status_line_provider
node install.mjs --uninstall                        # 移除 MCP server 注册与 provider 选择

node hud.mjs --version                              # 打印 codex-hud 版本号
node hud.mjs --preview                              # 用示例快照在终端预览（或 npm run preview）
node hud.mjs --preview --theme dracula              # 指定主题预览（如 dracula、one-half-light）
node hud.mjs --preview --state snapshot.json --json # 渲染自定义快照并输出 UI 树 JSON
node hud.mjs --doctor                               # 运行完整诊断与图标探针（或 npm run doctor）
node hud.mjs --doctor --json                        # 输出机器可读的 JSON 诊断报告
```

`--doctor` 只读。它执行[面向 AI Agent](#面向-ai-agent) 中列出的检查，打印图标探针，并用示例和极端输入检查是否超出 Codex 的 UI 树限额。

## 工作原理

Codex 0.171 加入了实验特性 `tui_extensions_statusline`，由 MCP server 提供状态栏。（`claude-hud` 和 `agy-hud` 则是运行一个 shell 命令，从 stdin 读 JSON、输出一行文字。）

1. provider 是一个 stdio MCP server，在 `tools/list` 中声明一个工具，并带上
   `_meta["openai/ui"].entrypoints = [{ type: "statusline", resourceUri: "ui://codex-hud/footer" }]`。
2. 在 TUI 中通过 `/statusline → Choose a status line provider` 选中它之后（选择会存成 `config.toml` 里 `[tui]` 下的 `status_line_provider`），Codex 大约每秒对该 URI 发一次 `resources/read`，并在 `params._meta["com.openai/codex-statusline-state"]` 中传入当前 thread 的快照：模型、推理强度、权限与审批模式、对话标题、cwd、context 用量、累计 token 与缓存命中率、额度、费用、agent 状态等。
3. provider 返回一棵 JSON UI 树（`row`、`text`、`bold`、`link` 等节点，颜色可使用主题色 `status-*`），由 Codex 原生渲染。协议限制：64 KiB JSON、256 个节点、深度 16、16 KiB 文本，每次读取 1 秒内必须返回。出错或超时会停止轮询，需在 `/statusline` 里重新选中。

协议说明见 Codex 二进制内置的 `create-statusline` skill。

插件的 `.mcp.json` 会把 `HOME`、`PATH`、`CODEX_HOME`、`XDG_CONFIG_HOME`、`CODEX_HUD_CONFIG` 和 `CODEX_HUD_DISABLE` 传给 server，其他变量不会传入。

除快照外，`codex-hud` 还读取以下本地数据：

| 段 | 来源 |
| --- | --- |
| `model` / `mode`（权限、审批、profile）/ `title`（可选）/ `context` / `tokens`（累计输入输出与缓存命中率）/ `limits`（5h、7d 额度）/ `cost` / `state` | 快照（`com.openai/codex-statusline-state`） |
| `project`（目录名 + git 分支、dirty、暂存/修改/未跟踪数、ahead/behind） | `git status --porcelain --branch`，缓存 2 秒，后台刷新 |
| `env`（`AGENTS.md` / MCP / skills 数量） | 扫描 `cwd` 与 `~/.codex` 配置与目录，缓存 30 秒，后台刷新 |
| `tools`（plan 进度与当前步骤、运行中 `◐` vs 已完成 `⚙` 工具计数、最后一条命令）、`session`（会话时长、轮次 `#N`、改动文件数 `✎ N`）与 `state` 本轮耗时 | 增量读取 `~/.codex/sessions/**/rollout-*-<thread-id>.jsonl` |
| 快照缺少 context 窗口大小时的 `context` | `~/.codex/models_cache.json`，缓存 60 秒 |
| 快照不含额度信息时的 `limits` | `~/.codex/sessions/` 下最新的至多 30 个 rollout 文件（任意 thread）的末尾 128 KiB，缓存 30 秒 |

## 配置

`codex-hud` 按以下顺序查找配置文件：

1. `CODEX_HUD_CONFIG`
2. `$XDG_CONFIG_HOME/codex-hud/config.json`
3. `~/.config/codex-hud/config.json`

修改后 5 秒内生效，无需重启。示例见 [`config.example.json`](./config.example.json)。

默认配置：

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

配置项说明：

- `segments`：段的显示顺序，删掉某项即隐藏该段。可用段：`model`、`mode`、`title`、`project`、`context`、`tokens`、`limits`、`cost`、`env`、`tools`、`session`、`state`。其中 `mode`、`title`、`tokens`、`env`、`tools`、`session`、`state` 默认不启用，按需加入 `segments` 即可。
- `groups`：折行时保持在一起的段（默认 `[["model", "project"], ["context", "limits", "cost"]]`）。它会取代 `segments`；只设置 `segments` 而不设置 `groups`，或者设为 `"groups": null`，就不分组。组与组之间用空格隔开，不加 `│`。Codex 只在宽度不够时才折行，所以宽终端仍显示一行；窄终端会在组与组之间断开，只有单个组本身比终端还宽时才在组内断开。Codex 没有给 provider 提供换行节点，所以无法固定显示两行。
- `barWidth`：进度条宽度（1–40，默认 `8`）。
- `icons`：改用 Nerd Font 图标（默认 `false`）。
- `allLimits`：显示所有额度桶，而不只是主 `codex` 桶（默认 `false`）。
- `showGitCounts`：是否在 git 分支旁显示暂存（`+`）、修改（`~`）、未跟踪（`?`）文件数（默认 `true`）。
- `showCacheRate`：是否在 `tokens` 段显示 Prompt Cache 命中率（默认 `true`）。
- `showLastCommand` / `lastCommandWidth`：是否在 `tools` 段末尾显示当前 turn 最后一条 shell 命令及截断宽度（4–200，默认 `true` / `32`）。
- `showPlanCurrent` / `planCurrentWidth`：当存在 `update_plan` 进度时，是否在 `☑ done/total` 旁显示当前 `in_progress` 步骤文本及截断宽度（4–200，默认 `true` / `24`）。
- `titleWidth`：`title` 段的最大字符宽度（4–200，默认 `32`），会自动清理换行与控制字符。
- `maxTools`：运行中（`◐`）和已完成（`⚙`）工具各自最多展示的 top 工具种类数（1–10，默认 `3`）。
- `warn` / `danger`：进度条变黄（`!`）、变红（`!!`）的百分比阈值（默认 `70` / `90`）。

类型不对的字段使用默认值，数值会被限制在各自范围内，`segments` 里的未知项会被跳过。

## 配色与主题

- 正常状态用 `status-*` 主题色和默认前景色，footer 会跟随 `/theme`。
- 进度条：标签和进度条用该段的主题色（`status-usage` / `status-limit`），百分比用默认前景色加粗：
  - 达到 `warn`：进度条变成 ANSI 黄，百分比前加 `!`。
  - 达到 `danger`：进度条变成 ANSI 红，百分比前加 `!!`。
  - 告警色来自终端的 ANSI 调色板，不跟随主题。有些主题的正常色本身偏黄或偏红（如 `one-half-light` 的 `status-limit`），所以另加 `!`/`!!` 标记。
  - 按显示的四舍五入值判断，`69.6%` 显示为 `! 70%`。
  - 关闭告警：把 `warn` 和 `danger` 都设为 `101`。
- `state` 段用 `◌` 表示 waiting，`●` 表示 working。
- `/statusline` 里的 "Use theme colors" 开关对自定义 provider 无效。

本地预览不同主题效果：`node hud.mjs --preview --theme dracula` 或 `--theme one-half-light`。

## 隐私与安全

`codex-hud` 是由 Codex 启动的本地 stdio MCP server，没有第三方运行依赖，不发网络请求。

- `hud.mjs` 只读：读取 `stdin` 上的 JSON-RPC 请求、本地配置（上限 64 KiB）、通过 `execFile` 执行 `git status`（无 shell 拼接，800 ms 超时），有界读取 `~/.codex/sessions/` 下当前 thread 的 rollout 文件尾部、`~/.codex/models_cache.json`，以及额度回退时最近至多 30 个 rollout 文件（任意 thread）的末尾 128 KiB。
- 渲染前会清理不可信字符串（对话标题、plan 步骤、shell 命令等）中的控制字符与 Unicode 双向覆盖字符。
- `node hud.mjs --doctor` 只读取本地文件并调用只读 `codex` 子命令（`--version`、`features list`、`mcp get`、`plugin list`）。`--doctor --json` 的输出含本地绝对路径，贴到公开 issue 前先检查一下。
- 完整安全模型与漏洞反馈方式见 [SECURITY.md](./SECURITY.md)。

## 开发

```sh
npm test
npm run preview
npm run doctor
```

无需构建步骤。开发流程与测试规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。本项目基于 [MIT License](./LICENSE) 开源。
