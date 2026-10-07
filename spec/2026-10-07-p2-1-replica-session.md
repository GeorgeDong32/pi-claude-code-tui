# ReplicaSession：把入口里隐藏的生命周期控制器搬进 lib

日期：2026-10-07

状态：规格已补齐，依赖 P0-1（teardown 语义）与 P0-2（core-bus client）先落地

范围：本仓库 `extensions/claude-code-tui.ts` → 新增 `extensions/lib/replica-session.ts`

来源：2026-10-07 联合架构审查，清单项 TUI-11（报告 T1 卡片）

## 1. 基线与事实

1. `extensions/claude-code-tui.ts` 有 1034 行，自 2026-09-15 起提交 45 次，是本仓库最热的文件。
2. 入口闭包持有 19 个可变量：
   - `enabled`、`toolRowsPref`、`statusLinePrefs`、`toolRowsEnabled`、`autoYieldNotified`、`channelActive`、`thinkingTipShown`；
   - `currentModelName` / `currentProviderName` / `currentContextWindow`；
   - `activeEditor`、`dockTui`、`spinnerPaint`、`statuslineRunner`、`statuslineWidth`、`showNativeFooter`、`accentOpenAnsi`、`themeFg`、`latestCtx`。

   它们由 `enable` / `disable`、9 个事件 handler、5 个命令、3 个 widget render 闭包共享。
3. 约 14 个 setup 步骤、约 12 个 teardown 步骤的顺序约束只存在于过程顺序和注释里。几个例子：
   - 补丁先于 widget；
   - `cc-status` 的 macrotask 重注册（`586-589`）；
   - footer 模式分支（`562-591`）；
   - 在场标记 activate / withdraw 配对。
4. 入口没有任何自动化测试——ARCHITECTURE §2 写明"接线层，靠 lib 单测 + 人工验证"。本轮审查发现的三个缺陷全部出在这里（P0-1 的非 TUI 守卫回归、shutdown 漏释放、header stale ctx）。

## 2. 目标与约束

### 2.1 必须实现

- `ReplicaSession` 持有上述状态，提供 `enable(ctx)` / `disable(ctx)` / `shutdown(ctx)` / `onModelSelect(model)` / `onUsagePoint(point, ctx)` / `setFooterMode(native)` / `setToolRows(pref)` 等少量方法。
- 所有 `ctx.ui` 调用都经过一个窄的 `UiSlots` duck type。
- 生命周期可以用录制式 fake 做表测。
- 入口只剩加载期注册（resolver、entry renderer、markdown transformer、命令）和事件路由。

### 2.2 显示层红线

纯搬移，渲染输出逐字节不变（golden 测试零改动）。

### 2.3 不做的工作

- 不改任何可见行为、命令文本、prefs 格式。
- 不改 lib 中已有的纯模块（cc-rows、statusline、run-state 等）。

## 3. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 |
| --- | --- | --- | --- | --- | --- |
| S1 | 形态 | A class；B factory | **A**——与 `RunStateMachine`、`SubagentPresentationBridge` 同构 | — | 无 |
| S2 | 依赖如何进入 | A 直接 import；B **构造参数注入**：`{ pi 子集, uiSlotsOf(ctx), coreBus, bridge, statuslineFactory, patches, prefs, clock }` | **B** | — | 参数较多，但都已有现成实现 |
| S3 | resolver 读取开关 | A resolver 仍读入口变量；B **resolver 读 `session.toolRowsDecisionInput()`** | **B** | — | 无 |
| S4 | 迁移方式 | A 一次性搬；B **先搬状态与 enable / disable / shutdown，再搬命令与 widget** | **B** | — | 无 |
| S5 | 旧的人工验证项 | A 全部重复执行；B **自动化已覆盖的逻辑步骤标记为自动验证，保留真机视觉与宿主时序项** | **B** | 不再把无须人工重复的步骤当门禁 | PR 逐项列映射，不能因 fake 表测删除视觉验收 |

## 4. 设计

### 4.1 interface

```
new ReplicaSession(deps)
  enable(ctx) / disable(ctx) / shutdown(ctx)
  onModelSelect(model)
  onUsagePoint(point: UsageObservationPoint, ctx)
  onCompactionStart(ctx) / onCompactionEnd(ok)
  onRunStart(ctx) / onRunSettled(ctx)
  setToolRows(pref: boolean | undefined) / setFooterMode(native: boolean) / setStatusline(prefs)
  toolRowsDecisionInput(): { channelActive, toolRowsEnabled, forced }
  renderStatusRow(width, theme): string[]      // cc-status widget 的 render 委托到这里
  renderFooterRows(width, theme): string[]     // cc-footer
```

`UiSlots` = `{ mode, setHeader, setEditorComponent, setWidget, setFooter, setWorkingVisible?, setHiddenThinkingLabel?, setWorkingIndicator, setWorkingMessage, notify, theme? }`。由入口用 `ctx.ui` 适配；测试用录制式 fake。

### 4.2 内部规则（写进头注释）

- `enable`：非 TUI 直接返回（P0-1 N1）。顺序：在场声明 → core-bus retry → 模型信息 → 工具行判定 → bridge start → 补丁 → header → editor → footer 模式 → working → thinking tip → statusline。
- `disable` 与 `shutdown` 共享私有 release，不互相公开调用导致重复释放；disable 额外恢复 UI 槽位。
- `shutdown`：P0-1 §4.2 的 8 步。
- 所有 render 委托整体 try/catch；last-good 按新 width 截断，无缓存时安全降级。UiSlots 不暴露一个可任意保存的完整 ctx；事件路径更新 model/cwd/usage 数据快照，render 不读旧 ctx。
- 状态为 inactive / enabling / active / disposing，资源登记取得成功后才写入释放栈。enable 中途失败时回滚已取得资源、撤回自身 presence，允许后续重试；不能 enabled=true 但只有半套 UI。
- 每次会话/启停切换更新 generation；所有 timer、晚到 callback、异步 statusline 结果带 generation 检查。P0-1 的 requeue timer 及 P0-2 的订阅 ownership 一起搬入，不重复实现。
- module 内持有状态写权；getter 只给只读投影。入口不得保留另一份 enabled/channelActive/latestCtx 并手工同步。
- 现有 settings/prefs 的读改写语义保持，纯数据选择函数继续复用。若 class 只是接收全部 getter/setter 再原样转发，未通过 deletion test，不算完成。

### 4.3 迁移

1. 新建 class，把 19 个状态与 `enable` / `disable` / `shutdown` 搬入；入口 handler 改为调用 session 方法。
2. 把 cc-status / cc-footer 的 render 体与 5 个命令的状态变更搬入。
3. 删除入口中的死变量；更新 ARCHITECTURE §2 模块表与 §3 事件流。

## 5. 测试与性能门禁

### 5.1 自动化矩阵（新增 `test/replica-session.test.ts`）

| 序列 | 断言 |
| --- | --- |
| rpc 模式 enable | UiSlots 零调用；在场未声明；补丁未安装 |
| tui enable → shutdown | 释放序列完整（bridge / obs / 在场 / runner / tick / editor / header / 补丁） |
| tui enable → disable → enable | 第二次 enable 幂等；不重复 notify thinking tip；补丁重装 |
| footer native ↔ blank 切换 | 两种模式下 setFooter / setWidget 的调用序列 |
| 工具行 auto，且存在外部 owner | `toolRowsEnabled=false`，autoYield 通知恰好一次 |
| 模型切换 | header 与状态行使用新模型名 |
| render 时 deps 抛错 / 宽度缩小 | 不抛，回落输出不超宽 |
| enable 中途抛错 / 重复 enable / 重复 shutdown | 已取得资源全部回滚，presence 不残留，重试恰一次启动 |
| 旧 generation timer/callback 晚到 | 零旧 ctx 读取、零新会话写入；旧 shutdown 不撤新 presence |

### 5.2 性能

render 委托不得增加每帧分配：沿用现有缓存，renderStatusRow 每帧只读状态。

### 5.3 真实终端验收

按 `docs/manual-verification.md` 中保留的条目执行一遍。

## 6. 完成定义

- `npm test` 与 `npm run typecheck` 双绿，golden 零改动。
- 入口目标约 400 行，但行数不是完成证明：资源与状态写权集中、事件路由有真实 factory 接线测试、无重复生命周期 owner 才算通过。
- `AGENTS.md` 与 ARCHITECTURE 中英两版的模块地图更新。

## 7. 代码依据

`extensions/claude-code-tui.ts:141-797, 799-992`、`extensions/lib/run-state.ts`、`extensions/lib/subagent-presentation.ts`
