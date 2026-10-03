# 架构评审落地 — 实施方案

> 依据：2026-10-03 架构评审（5 候选全部执行）。基线：`npm test` 101 绿 · `npm run typecheck` 干净 · HEAD = e9299ab。

## 总原则（全程有效）

- **纯显示层红线**：不改任何工具 `execute`、不改任何发给模型的内容。
- **行为等价**：所有提取/收敛保持渲染输出字节不变。唯一例外：obs_recall 表条目格式统一（见 Phase 2a，生产渲染实际不变）。
- **golden 策略**：`test/cc-rows.golden.test.ts` 的渲染断言全程不红；`callArgsFor` 的单元断言在 Phase 2 显式更新。
- **先钉后拆**：任何重构前，若目标输出缺字节级保护，先补字节断言再动实现（skill-row 展开块）。
- 每步验证：`npm test && npm run typecheck`；相对导入带 `.ts`、tab 缩进、patch 幂等、timer `unref()`、theme 惰性读取等 AGENTS.md 坑清单全部遵守。

## Phase 1 · 死码清扫（候选 3a，净减 ≈130 行，先做让后续 diff 干净）

**删除**：
| 位置 | 内容 |
| --- | --- |
| `extensions/lib/render-utils.ts:83-206` | `PI_WORKING_VERBS`（108 词旧表）+ `pickWorkingVerb` |
| `extensions/claude-code-tui.ts:34,36` | 死 import `renderDiff`、`Text`、`wrapTextWithAnsi` |
| `extensions/claude-code-tui.ts:120-123` | `shortenCwd`（零调用，且与 `formatCwd` 概念重复） |
| `extensions/lib/render-utils.ts:57-58` | `formatThinkingLabel`（恒等函数；调用点 `pi-startup-header.ts:229` 留给 Phase 4 的 effort seam 一并处理——本 phase 先改为内联等价调用） |

**顺手**：`tsconfig.json` 开 `noUnusedLocals`（防死 import 复发；typecheck 必须仍绿）。

验证：`npm test && npm run typecheck`。  
Commit: `chore(rows): drop dead code — legacy verb table, dead imports, shortenCwd, identity fn`

## Phase 2 · 工具行渲染接线收敛（候选 1）

### 2a. obs_recall 摘要统一进 `callArgsFor` 表
- `extensions/lib/cc-rows.ts` `builtinCallArgs.obs_recall`（:87）改为 entry 版逻辑：id 截 16 位（缺失 → `obs_?`），offset>0 → `+X.XKB`，否则 `start` → `id · offset` 格式。
- 删除 `extensions/claude-code-tui.ts:311-315` 的 `obsRecallSummary` 闭包；:319 的 ternary 去掉 obs_recall 分支（表条目即唯一规则）。
- **视觉影响：无**。生产路径（prototype patch）一直走 entry 格式，表条目原本不可达；这是「seam 外的副本」收编回 seam。
- `test/cc-rows.golden.test.ts` :172-174/:186 的 `callArgsFor("obs_recall")` 单元断言更新为新格式（非渲染 golden）。

Commit: `refactor(rows): unify obs_recall summary into callArgsFor (TR D2 format — no visual change)`

### 2b. component memo 收敛单处
- `cc-rows.ts` 新增导出 `createResultMemo()`：封装 key 构造 `{result, expanded, isError, theme}`、四字段引用相等比较、ccResult 调用与组件存放。
- 两个调用点改用同一实现：
  - `claude-code-tui.ts:568-598`（`ccRenderers.renderResult` 闭包 memo）
  - `claude-code-tui.ts:339-375`（`proto.getResultRenderer` 实例槽 `__ccResultMemo`，factory 身份检查保留——防同实例被不同 renderer 定义复用）
- 存放位置差异（闭包 vs 实例槽）保留，共享的是比较/构造/调用逻辑。

Commit: `refactor(rows): single component-memo implementation for both wiring paths`

### 2c. gutter-wrap 收敛 + skill-row 字节钉死
1. 先给 `test/cc-skill-row.test.ts` 的展开块断言升级为字节级（当前是 includes）。
2. `cc-rows.ts` 新增导出 gutter-wrap helper（⎿ gutter + 5 空格续行缩进 + `wrapTextWithAnsi` + 按 width 缓存）；`ccResult`（:277-283）与 `cc-skill-row.ts:95-110` 展开块改为共用。

Commit: `refactor(rows): shared gutter-wrap helper; byte-pin skill-row expansion`

### 2d. 接管决策矩阵提纯
- 新建 `extensions/lib/takeover-rules.ts`：纯函数 `decideTakeover({enabled, toolRowsEnabled, forced, isMcp, isBuiltin, hasOrig, toolName, slot: "call"|"result"|"shell"}) → "orig"|"cc"`；`FORCE_RESULT_EXEMPT` 集合迁入（含 subagent/obs_recall 豁免语义与注释）。
- `claude-code-tui.ts` 的 `getCallRenderer`(:301-305) / `getResultRenderer`(:337-339) / `getRenderShell`(:380-384) 三处内联判断各改为一行调用。
- 新建 `test/takeover-rules.test.ts`：矩阵全组合表驱动测试（enabled × toolRows × forced × mcp × builtin × exempt × slot），把现有三处条件的**差异**（result slot 的 EXEMPT、shell slot 的 toolDefinition 检查）作为显式用例钉死。

Commit: `refactor(rows): takeover decision matrix as pure fn + exhaustive table tests`

## Phase 3 · 入口纯逻辑提取（候选 2）

### 3a. markdown transformer → `lib/cc-markdown.ts`
- 导出 `assistantWhiteText(md: string): string`（plainLine 白名单正则 + fence 追踪）与 `userMessageBar(md: string, width: number, paints: {white, gray, bg, bgOff}): string`（NBSP 宽度数学、首行 ❯）。
- 入口 `registerMarkdownTransformer`（:1180-1216）只留 messageType 分发。
- 新建 `test/cc-markdown.test.ts`：fence 内保持、list marker 只包 text、标题/引用/表格行不动、user 灰条窄宽 pad、NBSP 对齐、多行长文。

### 3b. cc-status 行布局 + footer 标签 → `lib/cc-status-line.ts`
- 导出：
  - `statusRowLayout(left: string, right: string, width: number): string`（左右拼接三分支 + 降级）
  - `buildStatusRightGroup({model, effort, used, contextWindow, cost, muted, dim, sep}): string`（right 组：model·effort │ Ctx pct │ cost）
  - `permissionModeLabel(status: PmStatus, envMode: string, paint): string`（footer 模式标签，PM_MODE_PAINT + MODE_META fallback；从入口 :641-655 提取）
- 入口 `setStatusWidget`(:463-542) render 只剩：读缓存 → 调 helper → 返回。
- 新建 `test/cc-status-line.test.ts`：pct 边界（0%、>100% 截断）、win=0 分支、cost=0 省略、左右拼接三分支、宽度不足降级、mode meta 有/无、env fallback。

### 3c. effort 读取 seam → `lib/host-status.ts`
- `readEffortLevel(pi): string | undefined`（try/catch 收口 + duck-type 探测）。
- 四个调用点统一：入口 :441 / :512 / :675 + `pi-startup-header.ts:229`（**修掉无容错裸调用**，行为差异仅限于「host 异常时不再崩」）。

Commit（3a-3c 一组或分三笔，按 diff 体量定）：
- `refactor(tui): extract markdown transformer to lib/cc-markdown + table tests`
- `refactor(status): extract cc-status row layout & footer label + tests`
- `refactor(status): effort reads behind one seam (fixes unguarded header call)`

## Phase 4 · render-utils 归位与收窄（候选 3b）

- `center/padRight/headerColumnWidths/MIN_LEFT_WIDTH/MIN_TIPS_WIDTH/MAX_TIPS_WIDTH`（布局）与 `PI_BUILTIN_SLASH_COMMAND_NAMES/pickSlashCommandTips/collectPiCommandNames`（tips）迁入唯一使用者 `pi-startup-header.ts`。
- render-utils 剩余 7 个纯格式化函数（formatCwd/Duration/Tokens/Cost/buildCompletionLine/formatModelLabel/effortBadgeSymbol）→ 改名 `lib/format.ts`，两个 import 方同步。
- 新建 `test/pi-startup-header.test.ts`：`headerColumnWidths` 窄屏降级三分支、65% 保宽、tips 的 exclude/fixed/count/注入 RNG。

Commit: `refactor(utils): header layout & tips homed in pi-startup-header; render-utils → format`

## Phase 5 · run/compaction 状态机（候选 4）

- 新建 `lib/run-state.ts`：`RunState` module，注入 `{now, setTick, clearTick, requestRender}`；公开事件 `startRun(paint) / endRun() / startCompaction() / stopCompaction() / halt()`（disable 用）；只读视图 `view()` → `{phase, spinnerIdx, runStart, verb, lastWorkedLine}`。
- **不变量集中**：`tickTimer` 单一 owner；`stopCompaction` 仅 `!running` 清 timer；`endRun` elapsed≥1000 才产 completion line；verb 每 run 采样一次；tick 内异常静默停摆（不抛出 render 栈）。
- 入口 :199-205 状态变量与 :781-858 四个函数全部替换为该 module 调用；`SPINNER_TICK_MS` 引用随迁。
- 新建 `test/run-state.test.ts`：注入 clock/timer 驱动事件序——start→end、start→compact→compactDone→end、compact 期间 startRun（timer 重建）、disable mid-run、tick 抛异常停摆、<1s 不出 completion line。

Commit: `refactor(status): run/compaction state machine module + transition tests`

## Phase 6 · pm-capability 副作用摘除（候选 5）

- `readPmStatus`（pm-capability.ts:52-96）摘除 `trySubscribeCoreNotifications` 调用，变纯读。
- 新增导出 `ensurePmSubscriptions(display): boolean`（幂等重试，含通知订阅 attach 逻辑）；重试点从「读函数内部寄生」改为显式调用：entry `enable` + `session_start` 事件 + cc-status render 宽度检测处（成本与现状等价：一次 boolean 检查）。
  - **落地注记（2026-10-03）**：API 形状微调——`startCoreNotificationConsumer` 本身已是幂等重试入口，故未另造 `ensurePmSubscriptions`；新增的只有 `activateCcTuiChannel(display)`（publish + start 一步）。三重试点按本条落地。
- 生命周期配对：`publishCcTuiCapability` 与 `startCoreNotificationConsumer` 收敛为一个 `activateCcTuiChannel(display)`（内部 publish + start）；`withdrawCcTuiCapability` 保持反向单入口（内含 stop）。entry enable/disable 各调一个。
- `test/pm-capability.test.ts` 更新：断言 readPmStatus 不再触发订阅；singleton 隔离样板保留。

Commit: `refactor(pm): readPmStatus side-effect-free; lifecycle pairing symmetrical`

## Phase 7 · 文档收尾（候选 3c）

- `AGENTS.md` 目录结构表 + `docs/ARCHITECTURE.md` / `ARCHITECTURE.en.md` 模块表：收录 `spinner-verbs.ts`、`spinner-shimmer.ts`、`cc-skill-row.ts` 与全部新模块（takeover-rules / cc-markdown / cc-status-line / host-status / format / run-state）；render-utils 条目删除。
- `docs/manual-verification.md` 增补自验点：obs_recall force 行、skill 展开块、cc-status 三态（running/compacting/idle）、footer 模式标签、statusline 不变。

Commit: `docs: module map refresh (AGENTS + ARCHITECTURE zh/en)`

## 提交序列总览

| # | Phase | Commit | 渲染字节 |
| --- | --- | --- | --- |
| 1 | 死码清扫 | `chore(rows): drop dead code …` | 不变 |
| 2 | 2a | `refactor(rows): unify obs_recall summary …` | 不变（表断言更新） |
| 3 | 2b | `refactor(rows): single component-memo …` | 不变 |
| 4 | 2c | `refactor(rows): shared gutter-wrap …` | 不变 |
| 5 | 2d | `refactor(rows): takeover decision matrix …` | 不变 |
| 6 | 3a | `refactor(tui): extract markdown transformer …` | 不变 |
| 7 | 3b | `refactor(status): extract cc-status layout …` | 不变 |
| 8 | 3c | `refactor(status): effort seam …` | 不变 |
| 9 | 4 | `refactor(utils): header/tips homed; render-utils → format` | 不变 |
| 10 | 5 | `refactor(status): run/compaction state machine …` | 不变 |
| 11 | 6 | `refactor(pm): readPmStatus side-effect-free …` | 不变 |
| 12 | 7 | `docs: module map refresh …` | — |

## 收尾（Phase 8）

1. `npm test && npm run typecheck` 全绿；`node scripts/bench-statusline.mjs` 确认无回归。
2. 跑 code-review 双轴（standards：AGENTS.md 约定；spec：本 plan + goal criteria），修复 legitimate 发现项并复验双绿。
3. 输出自验清单（不阻塞）：force 模式 obs_recall 行、skill 展开 gutter、cc-status 三态、footer 标签。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| golden 意外红 | 逐 commit 提交前全量跑测试；红的唯一合法来源是 2a 表断言（已在 plan 内声明） |
| memo 收敛引入行为差 | factory 身份检查、存放位置差异原样保留；golden + golden.io 级断言覆盖 |
| render 内抛异常（坑 1） | 所有新 helper 入口保持纯函数/不抛；effort seam 显式 try/catch |
| pm 订阅重试点后移导致漏订阅 | enable + session_start + render 宽度检测三重显式重试，成本与现状等价 |
| jiti moduleCache: false 多实例（坑 4） | takeover-rules / run-state 为纯函数或显式单实例，无 prototype patch 新增 |
