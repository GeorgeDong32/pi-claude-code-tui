# 用量数字只显示一份（cost / ctx% 去重 · 消费 core 结构化用量 · 可选 effort 来源）

日期：2026-10-07

状态：规格已补齐；第一步可独立实施，第二步依赖 core `spec/2026-10-07-p2-4-structured-usage-channel.md`

范围：本仓库 `extensions/claude-code-tui.ts`（cc-status render）、`extensions/lib/cc-status-line.ts`、`extensions/lib/format.ts`、`extensions/lib/status-snapshot.ts`

来源：2026-10-07 联合架构审查，清单项 TUI-08 / TUI-10（报告 X3 卡片）

## 1. 基线与事实

1. **同一行出现两份 cost 与 ctx%。** 运行中的 cc-status 行由两部分拼成：
   - 左侧（`claude-code-tui.ts:435, 448`）拼接 core 发布的 `workingStats` 字符串，格式为 `↑in ↓out [R…] [⚡tps tok/s] $x.xxx [p% ctx]`（core `modes/index.ts:804-818`）；
   - 右侧（`455-466`，statusline 关闭时）再显示 UsageTracker 算出的 `Ctx p%` 与 `cost`。
2. 两份数字的口径不同，可能同屏不一致：
   - cost 精度：core 为 `toFixed(3)`；cctui 的 `formatCost`（`format.ts:26-28`）为 ≥1 分时 2 位、否则 4 位；
   - ctx%：core 用宿主 `getContextUsage().percent`；cctui 用 `used / contextWindow`，其中 used 是最后一条 assistant 消息的 input+output+cache（`status-snapshot.ts:57`）。
3. statusline 开启时（本机配置 `statusLine.enabled: true`），右侧组会折叠，但用户的 statusline 脚本行与左侧 pmStats 之间仍然重复。
4. effort 徽章读的是 `pi.getThinkingLevel()`（`host-status.ts:17`），看不到 core bus 的 `effort.source`（env / session / profile / model-default）。effort 被 `PI_CORE_EFFORT` pin 住时，用户无从得知。

## 2. 目标与约束

### 2.1 必须实现

- cctui 自己的状态行与内置默认 statusline 脚本之间，cost / ctx% 只保留一处，来源一致。任意用户脚本和 host 原生 footer 可自行输出数字，本包不能解析并强制整个屏幕去重。
- 没有 core 时，行为与现在相同（UsageTracker 继续工作）。

### 2.2 不做的工作

- statusline JSON 字段名与类型不变；第二步允许已存在 cost / ctx% 字段的数据源改变，须明确记录语义变化。
- 不改 UsageTracker 的采样点（spec 8.2）。

## 3. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 |
| --- | --- | --- | --- | --- | --- |
| U1 | 第一步怎么去重 | A 隐藏整个 pmStats；B **从 pmStats 中剔除 `$…` 与 `…% ctx` 两段，保留 ↑ / ↓ / R / tok/s**；C 隐藏右侧组 | **B** | A 丢掉 cctui 没有的 token 与速率数据；C 失去无 core 时的显示 | 依赖 core 字符串格式（以 `$`、`% ctx` 为锚点）。第二步改读结构化数据后，这个依赖随之消失 |
| U2 | 第二步以谁为准 | A cctui UsageTracker；B **core `modes.usage`（宿主 ctx%）优先，UsageTracker 作回退** | **B** | — | 无 |
| U3 | effort 来源（可选） | A 不显示；B **bus 有 `effort.source === "env"` 时，徽章加 `pinned` 标记** | **B**（可选） | — | 无 |

## 4. 设计

### 4.1 第一步

- `lib/cc-status-line.ts` 新增纯函数 `stripDuplicateStats(pmStats) → string`：按 ` · ` 分段，仅剔除完整匹配金额和 `% ctx` 数字格式的段。
- cc-status render 按下表选择 strip；不能不问有无替代展示就删除数字。匹配完整数字字段（含小数/0），保留未知字符串段，不用宽松 `$` 前缀删用户文本。

| 场景 | cost / ctx% 持有者 | 左侧 pmStats |
|---|---|---|
| cc-status 在场、statusline 关闭 | 右侧组（UsageTracker / 第二步的 core 优先） | 去掉重复数字 |
| 默认 statusline 有有效输出 | script 行 | 去掉重复数字 |
| statusline 等待首结果 / 空输出 / 失败，仅有错误行 | cc-status 右侧兜底组 | 有兜底才去掉重复数字；保留错误提示 |
| native footer 模式 | host 原生 footer；用户 script 自由输出 | cc-status 已卸载，不额外造一份统计 |

自定义脚本只接受同形 JSON，内容由用户控制；脚本有输出却故意不显示数字不视为本包漏显。

### 4.2 第二步（core P2-4 落地后）

- 新增 `readCoreUsage(store)`（纯读，duck-typed，放在 core-bus client 旁），返回经过 finite / 非负校验的数据（cost/input/output/cacheRead/cacheWrite 为累计值；ctxPercent/ctxTokens/contextWindow/tps 可选）或 null。
- 右侧组的 cost 与 Ctx%，以及 statusline JSON 的 `pi.cost_usd` 与 `context_window.used_percentage` / `remaining_percentage`（`statusline.ts:37-70`）：按字段选择 core 有效值，否则用 UsageTracker，真实 0 不走回退。选择出一个 display usage 对象，同时供状态行与 statusline JSON 使用；格式化前不再重算两份百分比。used/remaining percentage 一起由同一已 clamp 的 [0,100] 值推导，round 策略一致。
- 左侧改为由结构化数字自行格式化 `↑ / ↓ / R / tok/s`（用 `format.ts` 的 `formatTokens`），不再拼接 core 字符串。§4.1 的 `stripDuplicateStats` 只保留给旧 core 使用。
- statusline 输入更新继续走现有 debounce/request 合并；在 core usage 变化时触发输入刷新，渲染每帧不 spawn。宿主已有事件若足够则复用，并用“core 在原刷新后才 publish”的测试证明不会落后到下一轮。
- `current_usage` 的 lastInput/lastOutput 仍取 UsageTracker（core 累计值不能冒充单次请求值）；累计 total 字段可随选定累计来源同步。不把 core 的 ctxTokens 强塞成 lastInput。新 session / bus 缺失 / usage 被清空时回退，不能保留旧 core 的数字。

### 4.3 可选：effort pin 标记

`readCoreEffort(store)` 读取 `effort { level, source }`；`source === "env"` 时，徽章显示 `● high · pinned`。

## 5. 测试

| # | 用例 | 位置 |
| --- | --- | --- |
| U-T1 | `stripDuplicateStats` 表测：含 / 不含 cache、tps、ctx 的各种组合 | `test/cc-status-line.test.ts` |
| U-T2 | 有 core usage 时右侧组使用 core 数字；没有时使用 UsageTracker | 同上 |
| U-T3 | statusline JSON 在两种来源下字段形状不变 | `test/statusline.test.ts` |
| U-T5 | 旧 core / 无 core、0/缺失/NaN、new/reload 清空、statusline empty/error/native 组合，数字无意外消失或重复；core 晚 publish 后脚本按 debounce 刷新 | usage / entry 测试 |
| U-T4 | effort pin 标记（可选） | `test/cc-status-line.test.ts` |

## 6. 完成定义

`npm test` 与 `npm run typecheck` 双绿；`docs/manual-verification.md` 增加"运行中状态行无重复数字"；`CHANGELOG.md` 记录可见变化。

## 7. 代码依据

- 本仓库：`extensions/claude-code-tui.ts:389-466, 516-524`、`extensions/lib/status-snapshot.ts:42-71`、`extensions/lib/format.ts:19-28`、`extensions/lib/host-status.ts`
- core：`extensions/modes/index.ts:804-851`、`extensions/effort/index.ts:109, 193`
