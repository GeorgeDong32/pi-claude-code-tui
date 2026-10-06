# async surface seam 实施计划（Step 2b–4）

状态：2026-10-06。已完成 Step 1（特征化测试 8/8，`async-widget-characterization.test.ts`）与 Step 2a（`PresentationAsyncFrame` 类型 + host 校验器逐 surface 行数 + native map 窄签名，`252ee19`）。

## Step 2b — 投影 + 原生重实现（render.ts）

挂载点：`buildWidgetComponent` 的 `container.render` 内，替换最终组合调用：

```ts
const frame = projectAsyncWidgetFrame({ jobs, theme, width, expanded, collapsed, covered, tierMaterial });
const drawn = (options.seamDraw ?? drawNativeAsyncFrame)(frame);   // options 经 renderWidget 传入
cachedLines = drawn.lines.map((line) => paddedWidgetLine(line, renderWidth));
```

**tier 决策保持 owner 侧**（fitAdaptiveWidgetLines 的 session/锁定行为不动）：投影输入 tier（"single-line" | "full"）与可见 job 子集。owner 先跑现有 tier 逻辑得到可见集，投影只材料化可见部分。

**投影分层**（关键决策：材料捕获而非重推导）：
1. **header**：材料 = `{name(widgetJobName 输入), title, state, context, stats 文本, activity 文本, glyphState, compactWorkflow, singleChildJob}`。stats/activity 由 `widgetStats`/`widgetActivity` 在投影时算出（它们是纯材料函数）。
2. **detail 行**：wrap 词汇表（从组合函数归纳）：`gutter`（`  ⎿  {dim}`）、`indent-dim`（`  {dim}`）、`accent`（`  {accent}`）、`lane`（formatLaneProjectionLines 的行，结构化为 PresentationWorkflowLaneRow）、`phase`（checklist 行 → PresentationWorkflowPhaseRow）、`plain`。投影时调用现有函数取串，按来源函数登记 wrap 类别；native 用同公式重包 → 字节等价由特征化测试守护。
3. **children**：递归 section（materializedWidgetChildLines 的树），`childrenHidden` 记 `+N more workflow children`。

**native adapter**：`drawNativeAsyncFrame(frame)`——collapsed 单行（counts 公式）、full 模式逐 section 重排（header 公式 + wrap 重包 + 树连接符 `├─/└─/│`）。布局输出：每逻辑 row 一条 layout 记录。

**验收**：`async-widget-characterization.test.ts` 8/8 不改一字通过（字节等价）；新增 2 个测试（seamDraw 注入路径 + layout 覆盖 rowKeys）。

## Step 3 — 接线（index.ts）

- host `native` 加 `async: drawNativeAsyncFrame`（import 自 render.ts）。
- `renderWidget(ctx, jobs, collapsed, seamDraw?)` 加参；`async-job-tracker.ts` 的 `renderWidget` 调用点传入 `host.draw("async", frame)` 绑定。
- ready 广播 surfaces 自动含 "async"。

## Step 4 — CC 侧（本仓库）

- `subagent-presentation.ts` 镜像 async frame 类型。
- `cc-subagent-rows.ts`：`drawCcAsyncFrame`——header 用 CC glyph/标识（`○/●/✓`），detail 文本行包 CC `  ⎿  ` dim gutter，lane/phase/nested 复用 fleet 绘制，树连接符同 fleet；宽度 20/40/60/80/120 golden。
- bridge `surfaces` 加 `async: drawCcAsyncFrame`（host 侧按 ready.surfaces 过滤——已实现）；两 surface 都激活时 bridge.status() === "active" 且 surfaces 含两者（§5.1 完整能力语义）。
- 测试：cc-subagent-rows.test.ts 增 async 段 + bridge 双 surface 注册测试。

## 风险与守护

- adaptive tier 的 session 锁定行为跨帧语义：投影不碰 session（owner 侧不动），仅材料化当帧可见集。
- 动画 glyph（⠋）：frame.now 已带；glyph 由 adapter 从 glyphState+now 计算（native 用现 runningGlyph 公式）。
- 覆盖（inlineWorkflowCoverage）：继续 owner 侧（投影输入 covered 集合，材料化时剔除）。


## 完成记录（2026-10-06）

Step 1–4 全部落地：特征化 11/11（上游）、seam 分发（single-line/full 两 tier，progressive 留原生 v1）、CC 绘制 + 双 surface bridge、跨仓库 e2e（adapter 切换/撤回/布局验证零诊断）。已知边界：极窄终端的 progressive 卡片为原生降级；adapter 切换经 onAdapterChange 立即失效缓存。
