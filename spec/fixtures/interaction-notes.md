# P0 交互记录 — subagent Fleet 底栏（fork surface-tuning @ 0ebb9c83）

来源：安装副本 `src/tui/fleet-status.ts`（行号以 0ebb9c83 为准）+ `test/unit/fleet-status.test.ts`。P2/P3 的 CC adapter 必须保留这些控制契约（spec §4.2）。

## 激活与选择（handleKey，:757）

| 条件 | 行为 |
| --- | --- |
| `state.widgetsSuspended` | 直接返回 undefined（不消费） |
| `getActiveUiContext()` 为空 / `entries.length === 0` / `isKeyRelease(data)` | 返回 undefined |
| `inspectorOpen` | 返回 undefined |
| 编辑器无焦点（结构化鸭子检查 `focusedComponent`：`render`/`invalidate`/`handleInput`/`getText`/`setText` 均为函数，:1018） | 若已激活则 deactivate，返回 undefined |
| 未激活 + `↓` 或 `←` + `ctx.ui.getEditorText() === ""` | **激活**，selectedKey="main"，consume |
| 未激活 + 其他键 | 返回 undefined |
| 激活后 `↓`/`j` | selectedKey = roster 下一个（到尾不动） |
| 激活后 `↑`/`k` | 上移；**在 roster 顶部时 deactivate**（consume） |
| `Esc` | deactivate（consume） |
| `Enter` 且选中 `main` | deactivate（consume） |
| `Enter` 且选中 agent | `inspectorOpen=true` → `openInspector(key)`（异常走 `ui.notify`，finally 关闭并 refresh），consume |
| 激活后其他键 | deactivate 且**不消费**（:823） |

## 渲染门（render，:815）

`hasInlineSurface() === false` 或 `widgetsSuspended` 或 `inspectorOpen` 或 `state.fleetInspectorOpen` → 返回空行并清 coverage。**默认展开** roster（active 只门交互选择，不门展开）。

## 行布局（渲染事实，夹具已钉死）

- 顶层：`␣␣` 前缀 + 标记 + 名字；选中时前缀变 `>␣`（箭头原位替换，不插列）。
- 树行：`treeBranch(depth, "├─"/"└─")` = 4 空格×depth + 分支 + 单空格，标记紧跟；选中时标记格子被 `>`（accent）替换。
- 标记：`●` running / `○` 顶层 agent / `✓` success 完成 / `◦` muted pending / `✗` error / `■` warning。
- 右列（dim）：`tokens·elapsed`（如 `8.1k·16s`）；workflow 包装行固定 `usage on child rows`；projectPane 行 `${summary} · ${elapsed} ago`。
- 右对齐 `rightAlign()`：右列宽 + ≥1 空格 gap，左侧 `truncateToWidth` 截断；窄宽下截断产物含 ANSI reset（`…` 前后 `␛[0m`）。
- 完成行嵌套（9157ac4）：workflow 完成步骤渲染为 `├─ ✓ collect (scout) · complete · 8s · ↓ 2.2k window · 2.4k spent` 式的详情行。
- phase 行：`├─ ● Tasks · 1 done · running · 1 queued`（FALLBACK_PHASE_LABEL="Tasks"，accent 圆点 + muted 文案）。
- 行预算：`MAX_AGENT_ROWS=6`（owner + 4 可见后代 + 溢出）；底部 `␣␣␣␣␣␣␣␣↓ N more`（dim）。夹具未见 `↑ N more` 行——向上溢出的呈现待 P2 覆盖（spec §4.2 要求双向）。
- label 优先级（:905）：`displayLabel → runLabel → workflowKey → description`，空白化、`[prompt redacted]` 隐藏、>20 字符截为 19+`…`、与 type 同名则省略。
- 用量：`isActiveState`（running/queued/pending）才进底栏；failed/complete 的 async job 不显示（夹具 single-agents 中 tester 消失可证）。workflow 汇总不重复累加子任务（wrapper 只挂 usage 提示）。

## 语义色（tone 夹具）

`● main` 无色；`○` 顶层无色；右列/usage `dim`；phase 行 glyph `accent` + 文案 `muted`；完成 `✓` `success`；pending `◦` `muted`；树行 agent 名 `fleetAgentIdentityColor(identity)`（FLEET_AGENT_IDENTITY_COLORS 轮换：mdLink/mdHeading/syntaxFunction/syntaxKeyword/syntaxNumber/syntaxType…）。

## async widget surface（源码结构记录，未捕获字节夹具）

`src/tui/render.ts` 的工具结果渲染管线（`foregroundStyleWidgetDetails` 一族，:2389+）：host step 行 `${indent}${glyph} ${kind}: ${name} · ${state} · ${details}`（8 行上限 + `… +N host steps hidden`）、lane 投影行、checklist widget 行、`⎿  ${activity}`（dim）、nested 行（expanded 12 / 折叠 6 上限）。P2 做纯绘制时应为该 surface 出 golden（经其投影函数驱动）。
