# pi-claude-code-tui

一个复刻 Anthropic Claude Code TUI 外观与手感的 [pi](https://pi.dev) 包。

<img width="691" height="448" alt="image" src="https://github.com/user-attachments/assets/3a030401-ed14-4705-b865-fdaf35fcba4f" />


## 你能得到什么

- **启动头** — 像素风 Clawd 吉祥物 + 粗体 `Claude Code` 标题 + 当前模型名与 cwd（第三方模型名原样显示）
- **精简提示栏** — 平面分隔线、金色 `❯` 提示符、金色条状光标；编辑器为空时显示暗色旋转的 `Try "..."` 建议
- **CC 风格工具行** — `⏺ Tool(args)` 格式 + 暗色 `⎿` 输出槽、彩色 diff、红色错误提示（内置工具的执行逻辑完全不动，仅渲染层改造）。折叠输出上限为 **3 个物理行**（单行压缩 JSON 可能换行成几十个终端行，所以折叠按换行后的行数计算，而非逻辑行数），并带展开提示。调用进行中 `⏺` 圆点以 600ms 闪烁，成功/出错后定格。
- **Skill 调用行** — 原生 `[skill]` 盒子改为 CC 式 `⏺ Skill(name)`，SKILL.md 正文在 `⎿` 槽下展开（与其他工具行同款 gutter）；点击展开保留。
- **压缩（compaction）行** — `/compact` 时渲染为 `⏺ Context compacted from N tokens`（可展开摘要），进度同步镜像到状态行动词位置。
- **第三方 / MCP 工具回退** — 其他扩展注册的工具（MCP 适配器、`task` 等）没有自带渲染器，会用 pi 默认的 10 行 fallback 淹没对话记录；本扩展通过 prototype-patch `ToolExecutionComponent`，让任何没有 `renderCall`/`renderResult` 的工具都能获得同样的 CC 风格折叠行。官方 MCP 工具显示为 CC 同款 `server - tool (MCP)` 名字（`(MCP)` 后缀暗色）。
- **状态动词 + 流光** — 每次 run 从 187 个 Claude Code 俏皮动词中抽一个（`Pondering…`、`Vibing…`、`Flibbertigibbeting…`，加权抽样，彩蛋 `Piing…` 稀有）全程固定，花瓣帧动画推进、一道流光滑过动词（对齐 CC：动词不轮换，动感来自流光）；run 结束显示 `✻ Baked for 1m 12s · 13:54` 风格的收尾行，`/claude-verb` 可手动重掷。
- **状态行** — 提示栏上方显示 `model │ Context 23% (50k/200k) │ $0.042`。运行 `/claude-footer on` 可换回 pi 原生 footer（保留其他扩展的 footer，如 MCP 适配器——CC 状态组件会自动隐藏，避免重复）
- **底部提示行** — `⏵⏵ auto mode on …` 按键提示；输入框有内容时自动压缩为仅模式标签
- **历史消息** — 已发送的消息渲染为细长全宽灰条，带暗色 `❯` 前缀；assistant 正文纯白、markdown 样式行（标题/引用/代码）保留主题色（对齐 CC 的对话配色）
- **claude-code 主题** — 将 Claude Code 暗色调色板应用到整个 TUI

以上全部只是显示层：**不会改变任何发给模型的内容**。

## 安装

```bash
pi install git:github.com/GeorgeDong32/pi-claude-code-tui
```

然后在 pi 中打开 `/settings`，选择 **claude-code** 主题，重启 pi。

### 或者直接把这段复制给你的 AI 助手

```text
请帮我安装 pi 包 "pi-claude-code-tui"：
1. 运行：pi install git:github.com/GeorgeDong32/pi-claude-code-tui
2. 打开 pi，运行 /settings，选择 "claude-code" 主题
3. 重启 pi
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `/claude-tui` | 整体开关复刻效果（头图 / 编辑器 / 旋转动画 / 状态行；工具行独立控制，见下） |
| `/claude-tools` | 独立开关 CC 工具行：`on`（全量接管）/ `off` / `auto`（默认，自动让路） |
| `/claude-footer` | 切换 pi 原生 footer（`on`：保留 MCP 等扩展的 footer、隐藏 CC 状态组件；`off`：纯 CC 干净外观） |
| `/claude-verb` | 重新掷当前 run 的状态动词 |
| `/claude-statusline` | CC 兼容可配置状态行：`on` / `off` / `badge on\|off` / `set <command>`（详见下文「Statusline」） |
| `Shift+Tab` 或 `/mode` | 切换 **Plan Mode** / **Auto Mode** |

### 模式

- **Auto Mode** — 正常的完整工具权限（默认）
- **Plan Mode** — 只读研究：`edit`/`write` 工具被禁用，模型被指示先探索并给出方案，而不是直接改动

当前模式始终显示在提示栏下方提示行的左侧。

## 与其他 TUI 扩展的兼容性

pi 中工具渲染是单占位机制：`read` / `bash` / `grep` / `find` / `ls` / `write` / `edit` 这几行的样式只能由一个扩展接管。本包默认自动让位：

- **自动检测（默认）** — 每次会话启动时检查 `pi.getAllTools()` 的源元数据。如果其他扩展（如 [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)）已占用内置工具行，CC 工具行保持关闭并一次性提示原因。无需任何配置。
- **手动覆盖** — `/claude-tools on` 收回工具行，`/claude-tools off` 让出，`/claude-tools auto` 恢复自动检测。选择会保存到 `~/.pi/agent/claude-tui.json`，在 `/reload` 和重启后依然生效；`CC_TUI_TOOL_ROWS=0` 可强制关闭。
- **`on` 是全量接管** — 显式 `on` 时，自带渲染器的第三方工具（如 SoL-Pi 的 `obs_recall`、`update_plan` 和融合版 `edit`/`write`）也会渲染成 CC 行。只换渲染器：execute 与参数保持对方扩展的实现，SoL-Pi Action Fusion / Observation Pack 等功能完全不受影响（节省提示仍走它的 notify/状态栏）。`auto` 维持旧的让路契约。
- **头图/编辑器槽位**同样是单占位（后写者胜）。如果与其他 TUI 套件同时使用，请在 `settings.json` 的 `packages` 列表里把本包放在**后面**，这样头图和编辑器由本包接管。

### 与 SoL-Pi 同用

SoL-Pi 在 `session_start` 里才注册工具（且排在 packages 列表更后面），会静默夺走 `edit`/`write` 的渲染权，`auto` 的启动检测看不到它。同用 SoL-Pi 时建议运行一次 `/claude-tools on`：调用行（含 `obs_recall`，显示为 `⏺ obs_recall(obs_xxxx · +15.5KB)` 摘要）统一为 CC 行，Action Fusion / Observation Pack 照常工作；`obs_recall` 自带的分页结果视图与 `then_run` 徽章照常保留（TR 豁免，不被折叠成 3 行预览）。

### 与 pi-subagents 同用

`on` 模式对 pi-subagents 做了专门适配（1.4.5+）：

- **call 行摘要**：`subagent` 调用不再显示全量 JSON。对齐 CC「调用行 = agent 类型 + 任务描述」（AgentTool/UI.tsx:411）：单 agent → `⏺ subagent(scout · 概览目录结构)`；workflow 聚合 → `⏺ subagent(2×scout · 任务一 · 任务二 · +1)`（混合 agent 显示 `worker+reviewer`）；管理动作 → `⏺ subagent(stop abc123)`。
- **运行态不渲染冗余行**：配合 pi-subagents surface-tuning patch v3，`single · running` 这类「模式词·状态」行在运行中渲染为零行——状态由 call 行圆点颜色（accent=进行中）与 fleet roster 承载，完成行 `✓ <agent> · completed` 在结束时出现（CC 的 `Done (…)` 等价物）。
- **live 结果不被折叠**：subagent 自带的工作流 live 卡（每个 agent 的进度 / token / checklist，`ctrl+o` 看全文）**豁免**接管，进度内联在工具块内——对齐 CC「Task 进度在调用行下方」的设计。下方面板（Async agents）只保留真正的后台任务；前台调用的进度不会再掉到下面去。

## Statusline（CC 兼容可配置状态行）

像 Claude Code 的 statusline 一样：扩展把 CC 形状的 JSON（model / workspace / context_window，外加 `pi.cost_usd`、`pi.effort` 扩展字段）喂给你指定的命令 stdin，命令的 stdout（ANSI 原样）渲染在输入框下方——脚本行在上、mode/hints 行在下，effort 以 CC 式芯片（`⊙ high · /effort`，灰色）右对齐在首行末端（effort 未设或 off 时省略；`/effort` 是 pi-claude-code-core 注册的真实命令）。需要 bash + jq。

```text
 pi-effort │ ◆ main⎇ │ glm-5.3[1m] │ 30K/1M 3% │ I:28K/O:170      ⊙ xhigh · /effort
 ⚡ bypass mode on (shift+tab to cycle) · ! for bash mode · ctrl+p model · ctrl+o tools
```

- 默认关闭（`/claude-statusline` 开启），零视觉回归；开启后 spinner 行右段的 model/ctx/cost 收敛到脚本行，不双显。
- 开箱即用包内默认脚本（`~dir │ ◆branch dirty │ model │ Ctx p% │ $cost`）；要复用你在 CC 里的脚本：

  ```
  /claude-statusline set ~/.claude/statusline-command.sh
  ```

- 刷新只在会话事件发生（assistant 回复结束 / 切模型 / compaction / 终端宽度变化 / 配置变更），纯异步、绝不阻塞渲染；连续失败 3 次显示一行灰色提示并在下次成功后自愈。
- 配置持久化在 `~/.pi/agent/claude-tui.json`（`statusLine.enabled/command/badge`，与 `toolRows` 共存互不覆盖）。
- 性能：`node scripts/bench-statusline.mjs` 实测默认脚本 p50 ≈ 30ms（bash fork 地板约 25ms）；事件驱动下每分钟最多几次 spawn，不在热路径上。

## Thinking 折叠

Claude Code 默认折叠思考内容；pi 原生同样支持（`settings.json` 的 `hideThinkingBlock`，或会话里按 `ctrl+t` 切换，pi 自己持久化）。本包做两件事：

- 折叠标签换成 CC 风格的斜体 `✻ Thinking… (ctrl+t to expand)`
- 首次启用时若你从未选过折叠偏好，一次性提示快捷键

推荐的完整 CC 设置（加到 `~/.pi/agent/settings.json`）：`"hideThinkingBlock": true`

## 推荐设置

两个 Claude Code 行为存在于你的 pi 设置中（不在本包内），把它们加到 `~/.pi/agent/settings.json`：

```json
{
  "tuiMode": "fullscreen",
  "outputPad": 0,
  "quietStartup": true,
  "hideThinkingBlock": true
}
```

- `tuiMode: "fullscreen"` — 将提示栏和状态行固定到终端底部，对话记录可滚动（Claude Code 的行为方式）
- 注意：`Shift+Tab` 被改为切换模式，不再是 pi 内置的思考层级循环
- `outputPad: 0` — 已发送的消息从第 0 列开始顶格显示
- `quietStartup: true` — 隐藏启动时的资源列表（自定义头图保留）
- `hideThinkingBlock: true` — 折叠思考内容为一行 `✻ Thinking…`（等价于会话里按一次 `ctrl+t`）

## 说明

- 主题假定使用深色终端。
- 工具行样式覆盖了 `read`、`bash`、`grep`、`find`、`ls`、`write`、`edit` 的内置渲染器；执行始终委托给 pi 的内置实现。
- 编辑器组件改编自 Phoobobo 的 MIT 许可项目 [pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)。
- Claude Code 是 Anthropic 的产品。本包只模仿其终端美学，不含其任何代码。

## 故障排查

- **头图（Clawd）不见了** — 很可能是另一个 TUI 扩展在本包之后加载，清空了共享头图槽位。请在 `settings.json` 的 `packages` 列表里把本包放在它**后面**，然后 `/reload`。另外检查对方扩展自己的头图开关（pi-cc-extensions 是 `~/.pi/agent/claude-code-style.json` 里的 `showStartupHeader`）。
- **工具行显示异常 / 双重样式** — 两个扩展在样式化同一批工具行。运行 `/claude-tools off`（`/reload` 后依然生效）把工具渲染让给另一个扩展，或 `/claude-tools on` 收回。
- **切换了选项但没有任何变化** — pi 会在磁盘上缓存编译后的扩展。运行 `rm $TMPDIR/jiti/*claude-tui* $TMPDIR/jiti/*claude-code-tui*`，重启 pi 再试。
- **`/claude-tools off` 在 `/reload` 后失效** — 你用的是 ≤ 1.2.2 版本。重新运行 `pi install git:github.com/GeorgeDong32/pi-claude-code-tui` 升级到 ≥ 1.3.1，该版本会持久化选择。

如果以上都没用，请开一个 issue，附上你的 pi 版本（`pi --version`）、包版本和 `packages` 列表顺序。

## 文档

| 文档 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md)（[英文](AGENTS.en.md)） | 面向 AI 助手/贡献者的仓库指南：结构、命令、约定、常见坑 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（[英文](docs/ARCHITECTURE.en.md)） | 架构文档：模块地图、数据流、渲染接管机制、statusline 协议 |
| [docs/manual-verification.md](docs/manual-verification.md) | 视觉效果人工验证清单（自动化测试测不到的渲染行为） |
| [docs/STATUSLINE-PLAN.md](docs/STATUSLINE-PLAN.md) | statusline 设计过程存档（SL1–SL5 已全部落地） |
| [CHANGELOG.md](CHANGELOG.md) | 版本历史 |

## 许可证

MIT