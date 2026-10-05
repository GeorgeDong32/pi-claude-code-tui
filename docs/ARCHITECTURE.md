# ARCHITECTURE — pi-claude-code-tui

本文档描述 `@georgedong32/pi-claude-code-tui` 的内部架构：模块划分、数据流、渲染接管机制、statusline 子进程协议、配置持久化，以及与 pi 宿主的集成点。面向要改代码的贡献者；用户手册见 [README](../README.md)。

> English version: [ARCHITECTURE.en.md](ARCHITECTURE.en.md)。仓库工作约定与常见坑见 [../AGENTS.md](../AGENTS.md)。

## 1. 总览

本包是一个 pi 扩展 + 主题包，全部代码运行在 pi 的 TUI 进程内，**只改显示层**：渲染接管通过 pi 公开的扩展 API（工具行走官方 `pi.registerToolRenderer` 渲染器通道、`ctx.ui.setHeader/setEditorComponent/setWidget`、`registerMarkdownTransformer`）和有限的原型补丁（prototype patch：压缩行 / skill 行 / 用户消息条）实现，工具的 `execute` 与发给模型的内容一律不动。

```
package.json ("pi": { extensions, themes })
        │ jiti 加载（data: URL，moduleCache: false）
        ▼
extensions/claude-code-tui.ts   ← 入口 factory：事件接线 / 命令 / 模式开关
        │ 调用
        ▼
extensions/lib/*                ← 纯模块：渲染器、协议、IO、工具函数
themes/claude-code.json         ← 主题（pi theme 系统）
```

## 2. 模块地图

| 模块 | 职责 | 关键导出 | 测试 |
| --- | --- | --- | --- |
| `extensions/claude-code-tui.ts` | 入口。`export default function (pi)`；注册命令、订阅会话事件、装/卸各渲染槽位 | extension factory | （接线层，靠 lib 单测 + 人工验证） |
| `lib/cc-rows.ts` | CC 工具行渲染：`⏺ Tool(args)` call 行 + `⎿` 输出槽、彩色 diff、折叠（3 物理行上限）、gutter-wrap 布局、args 摘要表（result 引用 memo 已删——spec 8.4 评估证明全路径不命中） | `ccCall`、`ccResult`、`callArgsFor`、`gutterWrapRows` | `cc-rows.golden.test.ts`（逐字节 golden + 布局表测） |
| `lib/takeover-rules.ts` | 工具行接管决策矩阵（用户开关 × MCP × 内置七件 × force × 豁免，call/result 槽位 + shell 派生）与 resolver 计划层 `planResolverTakeover`；BUILTIN_SEVEN / FORCE_RESULT_EXEMPT 唯一定义点 | `decideTakeover` / `planResolverTakeover` | `takeover-rules.test.ts`（布尔矩阵全组合 + plan 表测） |
| `lib/cc-markdown.ts` | markdown transformer：assistant 白字（fence 追踪、list marker 保留）、user 灰条（NBSP 填充数学） | `assistantWhiteText`、`userMessageBar` | `cc-markdown.test.ts` |
| `lib/cc-status-line.ts` | cc-status 行：右侧组（model·effort │ Ctx p% │ cost，含 pct 截断/省略规则）、左右拼接三分支、footer 模式标签（MODE_META 投影） | `buildStatusRightGroup`、`statusRowLayout`、`permissionModeLabel` | `cc-status-line.test.ts` |
| `lib/run-state.ts` | run/compaction 状态机：tick 单一 owner、verb 每 run 采样一次、≥1s 完成行门控、stale ctx 静默停摆 | `RunStateMachine` | `run-state.test.ts`（注入 clock/timer 的事件序） |
| `lib/host-status.ts` | host 易变状态读取 seam（effort/思考档位，永不抛——render 栈安全） | `readEffortLevel` | `host-status.test.ts` |
| `lib/cc-compaction-row.ts` | 把原生 `[compaction]` 盒子补丁成 CC 风格行（经 pi-proto-adapter 生命周期）；在组件树里静音原生 "Compacting…" 指示器 | `patchCompactionRow`、`restoreCompactionRow`、`silenceNativeCompactionIndicator` | `cc-compaction-row.test.ts` |
| `lib/cc-skill-row.ts` | 把原生 `[skill]` 盒子补丁成 CC 式 `⏺ Skill(name)` 行（经 pi-proto-adapter）；展开块复用 cc-rows 的 gutter-wrap（字节钉死），保留原生点击展开 | `patchSkillRow`、`restoreSkillRow` | `cc-skill-row.test.ts`（含字节级展开块断言） |
| `lib/claude-tui-editor.ts` | CC 式编辑器：平面分隔线、金色 `❯`、主题色条状光标（530ms 闪烁、仅 focused、unref、release 幂等——spec 8.1）、补全面板弹到框上方 | `CodexStyleEditor` | `claude-tui-editor.test.ts`（timer 生命周期）+ 人工验证 |
| `lib/pi-startup-header.ts` | Pi-look 启动头：13 帧动画 logo、"Let's build something great"、模型/effort/cwd、tips 侧栏；header 布局宽度与 tips 选取纯函数同居于此（唯一使用者） | `applyPiHeaderLook`、`headerColumnWidths`、`pickSlashCommandTips` | `pi-startup-header.test.ts`（布局/tips 表测） |
| `lib/statusline.ts` | CC 兼容 statusline：JSON 合成、badge 数学、一次性子进程 runner、footer 行组合 | `buildStatuslineJson`、`composeFooterLines`、`StatuslineRunner` | `statusline.test.ts` |
| `lib/statusline-default-script.ts` | 内置默认脚本的 TS 内联副本（运行时无文件锚点，见 §8） | `DEFAULT_STATUSLINE_SCRIPT` | `statusline.test.ts`（与 scripts/ 字节同步） |
| `lib/status-snapshot.ts` | `UsageTracker`：按 USAGE_OBSERVATION_POINTS 采样（agent_settled 保证最终值、session_tree/compact 失效——spec 8.2） | `UsageTracker`、`USAGE_OBSERVATION_POINTS` | `status-snapshot.test.ts` |
| `lib/pm-capability.ts` | permission-modes 状态消费端（版本化能力通道 → 总线快照 → 遗留键的降级链，纯读）；核心通知队列消费（显式重试）；生命周期 activate/withdraw 配对 | `readPmStatus`、`activateCcTuiChannel`、`withdrawCcTuiCapability` | `pm-capability.test.ts` |
| `lib/subagent-presentation.ts` | subagent 展示 seam 消费端镜像：v1 协议常量/事件名、frame/row/layout 类型、有界 register/probe 客户端、bridge 生命周期（probe→注册→晚宿主补注册→撤回） | `SubagentPresentationBridge`、`registerSubagentPresentation`、`probeSubagentPresentation` | `subagent-presentation.test.ts`（7 生命周期）+ `cc-subagent-rows.test.ts` 协议段 |
| `lib/cc-subagent-rows.ts` | CC subagent 纯绘制：Fleet roster（glyph/树分支/选择箭头原位/紧凑 tok·time 右列/双向 overflow/identity 色散列）消费只读 frame，产出 lines+layout；无 IO、无 runtime | `drawCcFleetFrame`、`subagentIdentityColor` | `cc-subagent-rows.test.ts`（行型×选择×宽度×布局钉死） |
| `lib/pi-proto-adapter.ts` | pi 自有组件原型补丁的集中生命周期：原方法保存、marker=refresh 函数（重装刷新 getter）、宿主形状检查、异常降级到原方法、restore 仅撤自己仍拥有的改写 | `PrototypeMethodAdapter` | `pi-proto-adapter.test.ts`（8 生命周期） |
| `lib/prefs.ts` | `~/.pi/agent/claude-tui.json` 读改写：合并写 + tmp/rename 原子替换，坏文件回退 `{}` | `loadPrefs`、`savePrefs` | `prefs.test.ts` |
| `lib/format.ts` | 纯值格式化：时长/token/cost、模型/effort 标签、完成行 | `formatDuration`、`formatTokens`、`formatCost`、`buildCompletionLine` | `format.test.ts` |
| `lib/spinner-verbs.ts` | spinner 动词表：187 词与 CC 字节对齐（Clauding→Piing）、加权抽样（staples ×3 / eggs ×0.25） | `weightedVerbSample`、`SPINNER_VERBS` | `spinner-verbs.test.ts` |
| `lib/spinner-shimmer.ts` | spinner 动词流光（CC computeShimmerSegments 移植） | `shimmerSegments`、`SPINNER_TICK_MS` | `spinner-shimmer.test.ts` |
| `themes/claude-code.json` | claude-code 主题：vars（色板变量）+ colors（pi 语义色映射）+ export | — | — |
| `scripts/statusline-default.sh` | 默认 statusline 脚本（source of truth） | — | 字节同步由 `statusline.test.ts` 钉住 |
| `scripts/bench-statusline.mjs` | 默认脚本性能基准（p50 ≈ 30ms，bash fork 地板 ~25ms） | — | — |

依赖方向：入口 → lib 单向；lib 之间有少量纯函数复用（`cc-skill-row` → `cc-rows` 的 gutter-wrap、`cc-status-line` → `format`、`pi-startup-header` → `format`/`host-status`），均为纯依赖、无环。lib 不 import pi 运行时状态，只 import 纯函数（`pi-tui` 的 `visibleWidth` 等）与少量 pi-coding-agent 导出（`keyText`、`renderDiff`、被 patch 的组件类）。

## 3. 生命周期与事件流

入口 factory 在扩展加载时执行一次，但**工具注册与槽位接管发生在 `session_start`**（`enable(ctx)`）——因为所有权探测需要等所有扩展注册完毕，且非 TUI 模式保持原样。

```
load（jiti）
  ├─ 注册命令：claude-tui / claude-tools / claude-footer / claude-verb / claude-statusline
  ├─ UserMessageComponent.prototype.rebuild 补丁（压缩条上下空行，幂等标记 __ccCompact）
  └─ registerMarkdownTransformer（assistant 纯文本强制白色；user 消息 CC 式全宽灰条）

session_start → enable(ctx)
  ├─ 工具行模式判定（见 §4）
  ├─ ctx.ui.setHeader(...)            ← 启动头（tui 模式）
  ├─ ctx.ui.setEditorComponent(...)   ← CC 编辑器
  ├─ ctx.ui.setWidget("cc-status")    ← spinner / 完成行状态组件
  ├─ ctx.ui.setWidget("cc-footer")    ← statusline + mode/hints 行
  ├─ patchCompactionRow(getFg)        ← 压缩行 CC 化
  ├─ publishCcTuiCapability()         ← 告知 pm 本包存在（互相抑制）
  └─ startCoreNotificationConsumer()  ← 消费核心通知尾队列（失败自动重试）

运行期事件
  ├─ message_end / agent_start / agent_settled → UsageTracker.observe() → statusline 刷新、cc-status 更新
  ├─ model_select → 状态行刷新
  ├─ session_before_compact → 静音原生指示器、cc-status 显示压缩进度
  ├─ session_compact(_failed) → 恢复
  └─ session_shutdown / disable → setHeader/setEditorComponent/setWidget(undefined)，withdraw 能力
```

`/claude-tui` 是总开关（头图/编辑器/动画/状态行；工具行独立），`/claude-tools`、`/claude-footer`、`/claude-statusline` 分别控制三个子系统并把选择持久化到 prefs。

## 4. 渲染接管机制（核心）

### 4.1 工具行：官方渲染器通道（pi ≥ 1.0.1，`pi.registerToolRenderer`）

全部工具行（内置七件 / 第三方 / MCP）经由**单一 resolver** 接管（spec：`specs/design/2026-10-03-pi-1.0-tool-renderer-migration`）。pi 在每次 `ToolExecutionComponent` 构造时（流式 / 执行开始 / 转录重建）调用 resolver，`next()` 返回「其余 resolver + 注册工具定义 + pi 内置渲染器表」的合成结果。resolver 按 `lib/takeover-rules.ts` 的 `planResolverTakeover` 决策，**按槽位合并**：接管的槽换成 CC 渲染器，让路的槽原样保留 `next()` 的值，`renderShell` 由 call 决策派生（接管→`"self"` 平铺；第三方让路也保平铺）。只换渲染器，`execute` 与参数从不触碰。

决策矩阵（单一家园，全组合表测）：用户开关门控一切；官方 MCP 工具恒接管（CC 行即用户要的形状）；内置七件（`BUILTIN_SEVEN` 名单，**不含 powershell**——pi 内置渲染器表的第 8 键，保持 stock）rows-on 即接管；自带渲染器的第三方工具 auto 让路（另一 TUI 扩展可能拥有视觉）、`/claude-tools on` 强制接管；无渲染器的第三方工具恒接管；`FORCE_RESULT_EXEMPT`（subagent live 卡 / obs_recall 分页）豁免 forced 的 result 槽。

memo（plan A6）：resolver 每次调用恰好对应一个组件构造（pi 不缓存），闭包内建 `newResultMemoSlot()` 即每组件一 memo；`renderResult` 每帧被调用时复用组件与 wrap cache。折叠上限是 **3 个物理行**（终端换行后的行数）。

旧机制（`pi.registerTool` 重注册内置七件 + `ToolExecutionComponent` 原型补丁）已于 1.8.0 删除。工具所有权探测仍在 `session_start` 用 `pi.getAllTools()` 源元数据（`externalToolOwner`，名单 import `BUILTIN_SEVEN`）——resolver 的 `next()` 无法区分内置渲染器与他人注册的渲染器；像 SoL-Pi 这种更晚 `session_start` 才注册工具的扩展探测不到，README 建议同用时手动 `/claude-tools on`。pi < 1.0.1 时扩展照常加载，但工具行走 stock 并打一条 console.warn（git 安装不强制 peerDependency）。

三种模式：`auto`（默认）、`on`（全量接管）、`off`（让路）。开关只影响**新出现的工具行**（resolver 逐构造求值）；已渲染行不回改。`off`/`auto-off` 让路即时生效，不再重注册踩掉他人定义。

### 4.2 其他渲染层补丁

- **压缩行**：`CompactionSummaryMessageComponent.prototype.updateDisplay` 补丁成 `⏺ Context compacted from N tokens` 一行，摘要走 `⎿` 槽展开；同时剥掉 Box 背景/内边距，让行贴平转录区。
- **原生压缩指示器静音**：类未导出，所以在 TUI 组件树上搜 `CompactionStatusIndicator` 实例并覆盖其 `render` 为零行（实例级覆盖，pi 自己会在压缩结束时清理）。
- **用户消息条**：`UserMessageComponent.prototype.rebuild` 补丁把子组件 `paddingY` 清零（紧凑条）；markdown transformer 把 user 消息渲染成 `❯ ` 前缀 + rgb(55,55,55) 全宽背景条（NBSP 补宽），assistant 纯文本行强制白色、markdown 结构行保留主题色。

## 5. Statusline 子进程协议

参照 Claude Code 的 statusline 契约：扩展合成 **CC 形状 JSON**（`model` / `workspace` / `context_window`，外加本包扩展字段 `pi.cost_usd`、`pi.effort`）喂给用户命令的 stdin，stdout（含 ANSI）按行渲染在输入框下方；脚本行在上，mode/hints 行在下（同一个 `cc-footer` widget，天然定序）。用户的 `~/.claude/statusline-command.sh` 零改动复用。

`StatuslineRunner` 的调度纪律（保证渲染路径绝不 spawn）：

- **事件驱动**：`message_end` / 切模型 / compaction / 终端宽度变化 / 配置变更才刷新；
- **250ms debounce** 合并突发；**in-flight 合并**（飞行中的请求若输入没变则丢弃，变了记 `pendingAfterInFlight` 落地后补一发）；
- **2s 超时**；输出截到 **4 行 / 64KB**；
- **连续失败 3 次**降级为一行灰色提示，下次成功自愈；
- 子进程 env 里注入 `OVERRIDE_TERM_WIDTH`，脚本按宽度从右往左丢段。

`composeFooterLines` 负责组合：statusline 行（可选）+ effort badge（`appendBadge`，右对齐芯片）+ cc-footer 原样的 mode/hints 行；`/claude-footer on` 时整个 CC 状态组件隐藏、pi 原生 footer 回归（保留 MCP 适配器等扩展的 footer）。

## 6. 配置持久化

所有开关存 `~/.pi/agent/claude-tui.json`（路径尊重 `PI_CODING_AGENT_DIR`）：

```json
{ "toolRows": true, "statusLine": { "enabled": true, "command": "", "badge": true } }
```

写入统一走 `savePrefs`：读盘 → 展开 → 合并 → 写 tmp → rename。`undefined` 值删除键（`/claude-tools auto` 回到自动模式用）。历史上 `toolRows` 和 `statusLine` 互相覆盖过，这是纯模块 + 原子写重构（SL2）的直接原因。`CC_TUI_TOOL_ROWS=0` 是环境级强制关（无视 prefs）。

## 7. 与其他扩展的集成

- **permission-modes（pm）**：`Shift+Tab` 在编辑器 `handleInput` 里拦截（先于 pi 内置思考循环），切 Plan/Auto。pm 状态经 `readPmStatus` 的三级降级链读取：核心总线快照 `__piClaudeCodeCore.modes`（主源）→ 版本化 `__piPermissionModes` 能力对象 → 遗留 `__pmWorkingStats` 字符串 + `PERMISSION_MODES_INHERITED_MODE` 环境变量。模式图标/标签取自 pm 发布的 `meta`（单一来源：core 的 MODE_META）。
- **通知显示**：本包声明 `notificationsConsumer: true`，通过核心快照的 `onChange` 消费通知尾队列（按 `lastSeenId` 差分），核心随即停掉自己的直接转发——版本协商，避免双显；旧核心保持转发。
- **pi-subagents（展示 seam）**：subagent **底栏**（Fleet roster）经 `pi-subagents:presentation:v1:*` 事件族接管绘制——本包的 `SubagentPresentationBridge` 在 session_start 时 probe/注册 `drawCcFleetFrame`，宿主侧投影只读 frame、校验 layout、失败自动回退原生并去重诊断（console.warn 一条）。spec：`spec/2026-10-05-cc-tui-subagent-presentation.md`。工具行走原有 resolver 决策不变（auto 让路 / `/claude-tools on` 强制）；`/claude-tui off` 撤回 adapter 即恢复原生。要求 pi-subagents ≥ presentation-seam 分支（fork GeorgeDong32/pi-subagents），无 seam 时保持原生底栏、无 timer 无空白占位。
- **pi-subagents（工具行）**：`on` 模式专门适配（call 行 agent 类型 + 任务摘要、live 卡豁免折叠），见 §4.1 与 README。
- **槽位共存**：头图/编辑器槽位后写者胜；与其余 TUI 套件同用时建议本包排在 packages 列表后面。

## 8. 运行时约束（为什么代码长这样）

- **jiti `moduleCache: false` + data: URL**：`import.meta.url` 不指向安装目录 → 任何"读包内文件"的需求都要内联（默认 statusline 脚本因此以 TS 字符串存在，与 `scripts/statusline-default.sh` 字节同步，`statusline.test.ts` 强制）；同一组件类可能出现多个模块实例 → 深路径 import 补丁不可靠，优先用 pi 导出的类 + 幂等标记。
- **渲染回调不能抛**：`render()` 在 pi 无法捕获的栈里执行。所有降级路径（无 jq、脚本失败、prefs 损坏、主题缺失）都静默回退。
- **每帧成本**：render 只读缓存（UsageTracker 快照、runner 已完成行）；宽度变化是每帧唯一的检测点。blink 定时器仅 focused 翻转，全部 `unref()`，`requestRender` 非强制以保住 pi 的行 diff 缓存。
- **ctx 时效性**：`session_start` 的 ctx 在 session 替换后失效 → theme 一律惰性/每帧读取，accent ANSI 序列在 enable 时缓存一份字符串（`setEditorAccentOpen`）。

## 9. 主题

`themes/claude-code.json` 遵循 pi theme schema：`vars` 定义 Claude 暗色板（accent = `#8ABEB7` sage、userMsgBg、diff 色对等），`colors` 把 pi 语义色（accent/border/toolOutput/mdHeading/…）映射到 vars。编辑器光标与补全面板从 theme accent 派生 ANSI 序列（fg→bg 换算），保证换主题时光标跟随 accent。

## 10. 测试架构

- **纯模块单测**（`node --test`，TS type stripping 直跑）：prefs 原子写、UsageTracker 语义（used=最后一条 assistant 的累计；cost=求和）、statusline JSON 形状与 badge 数学、pm 降级链与生命周期配对、format 格式化、header 布局/tips、markdown transformer、cc-status 行三分支、接管矩阵布尔全组合、run 状态机事件序、memo/gutter-wrap 复用。
- **Golden 渲染测试**：`cc-rows.golden.test.ts` 用 identity/recording 两种 theme 钉住渲染字节与颜色路由，是 A6 wrap-cache 及后续渲染改动的等价网。`keyText()` 无 host 返回 `""` → 测试里断言字面量 fallback。
- **字节同步测试**：`DEFAULT_STATUSLINE_SCRIPT` ↔ `scripts/statusline-default.sh`。
- **人工验证**：`docs/manual-verification.md` 覆盖自动化测不到的视觉行为（spinner 帧推进、光标闪烁、resize 伪影、statusline 防抖回归等）。

## 11. 历史设计文档

`docs/STATUSLINE-PLAN.md` 是 statusline 子系统（SL1–SL5）的完整设计过程（rev1→rev3、用户决策 D0–D5、性能门），已全部落地，仅作决策存档；当前行为以本文档与代码为准。
