# STATUSLINE-PLAN — cctui CC 兼容 statusline（v1.5.0 提案 · rev3）

日期：2026-09-22 ｜ 状态：**已实现（SL1–SL5 落地，测试绿；性能门实测见 §7 addendum）**
基底：当前 main（v1.4.5, a008e17）。**不恢复** 09-16 被烧线（`a6fa343^` = 3087002，
rev2 内置段方案）；其 diff 仅作参考——rev2 的 GitStatusCache 整块不再需要（脚本自己跑 git）。

rev3 相对 rev2 的路线翻转（用户 2026-09-22 拍板 D0–D5）：

| # | 决策（用户原话要点） | 与 rev2 的差异 |
|---|---|---|
| D0 | spinner 完成后**变灰**（像 CC），标注**运行时长 + 结束时间** | 新增；现状 accent 高亮、无结束时间 |
| D1 | **合成（CC 形状）JSON + 简单脚本**路线，先验证性能，无问题则用 | rev2 明确排除用户脚本 → rev3 以外部脚本协议为核心 |
| D2 | statusline 并入 **cc-footer widget**：先渲染用户 statusline，再渲染 cc-footer 原样内容 | rev2 是独立 widget + 顺序实测兜底 → rev3 单 widget 天然定序 |
| D3 | **会话事件触发**刷新；**显示价格** | rev2 有 5s git 兜底定时器 → 删除；cost 进合成 JSON |
| D4 | 模型·effort 像图二放在**第一行 belowEditor 最右** | rev2 收敛右段即弃 → rev3 右侧加 badge → 09-22 收敛为 CC 式 effort-only 芯片 |
| D5 | 基于当前 1.4.5 线；**先落 spec** | rev2 基于已烧掉的 1.4.3 线 |

---

## 1. 目标与范围

cctui 增加一个 **CC 协议兼容的可配置 statusline**：扩展合成 CC 形状 JSON 喂给外部命令的
stdin，命令输出（含 ANSI）原样渲染在输入框下方。用户的 `~/.claude/statusline-command.sh`
**零改动复用**；包内附带一个简单默认脚本开箱即用。

**In scope**：JSON 合成器；子进程 runner（防抖/in-flight/超时/失败策略）；渲染并入
cc-footer widget（D2 顺序）；effort 右对齐芯片（D4）；完成行变灰 + 时长/结束时间
（D0）；claude-tui.json 配置 read-modify-write 重构 + `/claude-statusline` 命令；性能验证门。

**Out of scope**：theme 系统改动；tool rows / editor / header / transcript（一行不动）；
rev2 的内置分段拼装与分段开关（被脚本路线取代）；常驻子进程协议；Windows（脚本路线需
bash+jq，README 注明）。

## 2. 布局（rev3 定稿）

pi 0.85.1 dock 顺序 `widgetsAbove → editor → widgetsBelow → footer`（rev2 已核实）。
**statusline 不再是独立 widget**（D2）：cc-footer widget（belowEditor）的 render 顺序 =
`[...statuslineLines, footerLineText]`——用户脚本行在上，mode/hints 原样行在下。

```
 ✻ Percolating… (1m 21s · esc to interrupt)  ↑88k ↓1.0k ⇄26k ⚡27 tok/s   ← cc-status（左半保留，右段收敛）
 ┌─ editor ─┐
 ❯ ▍
 └──────────┘
 pi-effort │ ◆ main⎇ │ glm-5.3[1m] │ 30K/1M 3% │ I:28K/O:170      ⊙ xhigh · /effort   ← 脚本输出（≤4 行）+ D4 芯片
 ⚡ bypass mode on (shift+tab to cycle) · ! for bash mode · ctrl+p model · ctrl+o tools   ← cc-footer 原样
```

两种 footer 模式下的行为（`applyFooterMode` 扩展，`claude-code-tui.ts:610`）：

| 模式 | footer slot（最底） | cc-footer widget（belowEditor） |
|---|---|---|
| native ON | pi 原生 footer（现状不变） | `[...statusline, hints]` |
| native OFF | hints（现状不变，minSize:1） | `[...statusline]` |

statusline **disabled**（默认）时逐字节等于 v1.4.5 现状（golden 钉住）。

## 3. JSON 合成契约（D1）

字段名**实测自用户脚本**（`~/.claude/statusline-command.sh:7-17` 的 jq 表达式），非文档转述：

| 合成字段 | pi 数据源 | 说明 |
|---|---|---|
| `model.display_name` | `currentModelName`（model_select 维护） | |
| `model.id` | `` `${provider}/${modelId}` `` | provider 空时裸 modelId |
| `workspace.current_dir` / `project_dir` | `process.cwd()` / 同 current_dir | git root 发现留给脚本 |
| `context_window.context_window_size` | `currentContextWindow`（model_select 维护） | |
| `context_window.current_usage.input_tokens` / `output_tokens` | UsageTracker 扩展：**最后一条** assistant 的 usage.input / usage.output | 单 turn 口径 |
| `context_window.total_input_tokens` / `total_output_tokens` | UsageTracker 扩展：全 branch assistant 累计 Σinput / Σoutput | pi footer 同口径 |
| `context_window.used_percentage` / `remaining_percentage` | `round(used/win*100)`，used = 现行口径（最后一条 assistant 的 input+output+cacheRead+cacheWrite） | 与 cc-status 现显 Ctx% 同数，收敛后无双口径 |
| `pi.cost_usd` | `usageTracker.get().cost` | **D3 价格**；用户脚本忽略未知键，默认脚本用它 |
| `pi.effort` / `pi.provider` | 渲染时 `getThinkingLevel?.()` / provider | badge 与脚本可用 |

- 合成器 = **纯函数** `buildStatuslineJson(snapshot, model, win)`，输出 JSON 一次
  `JSON.stringify`；schema 用 golden 测试钉死（含空 model / win=0 降级）。
- spawn env：`cwd = process.cwd()`，`OVERRIDE_TERM_WIDTH = <render width>`（用户脚本
  `:20-23` 原生支持，双行自适应由脚本自己完成）。
- UsageTracker（`lib/status-snapshot.ts`）扩 4 个字段：`lastInput/lastOutput/totalInput/
  totalOutput`——observe() 已是 O(branch) 单次扫描，顺手累加，无新扫描。

## 4. Runner 设计（design-it-twice，接口三案）

| 方案 | 描述 | 判决 |
|---|---|---|
| (a) **逐事件 one-shot spawn** | 每次刷新 `spawn("bash", ["-c", cmd])`，stdin 喂 JSON，收 stdout | ✅ **选**：与 CC 协议完全同构，用户脚本零改动；无状态最好测 |
| (b) 常驻子进程 + 行协议 | fork 一次，长连接推 JSON 拉行 | ❌ 自造协议，CC 脚本不兼容；进程生命周期/半包都是新坑 |
| (c) 导入脚本为 JS 模块 | 用户改写脚本为模块导出 | ❌ bash 脚本无法复用，与 D1 初衷相反 |

runner（新 `lib/statusline.ts`）规则：

- **刷新触发（D3，纯事件，无定时器）**：`session_start` / `message_end`(assistant) /
  `model_select` / `session_compact` / `session_before_compact` / `/claude-statusline` 变更 /
  终端宽度变化（防抖 300ms 重喂）。rev2 的 5s git 兜底定时器**删除**（git 由脚本自查）。
- **防抖 250ms + in-flight guard**：连发事件合并为一次 spawn；在飞时只记 pending，落地后
  若有 pending 再补一发（`max 1 补发`，不排队）。
- **超时 2000ms kill**（用户脚本自身无超时；大仓 git 慢由脚本内部消化不了时兜命）。
- **失败策略**：非零退出/超时 → 保留 last-good；**连续 3 次失败** → 渲染一行 dim
  `<statusline> cmd failed (exit N) — /claude-statusline off`，之后仍按事件重试，成功即恢复。
- **行数上限 4**：stdout 按 `\n` 切分、去尾空行，超 4 行截断（防脚本失控顶穿 dock）。
- **异步纪律**：spawn 回调只写缓存 + `dockTui?.requestRender()`，**render() 内绝不 touch
  ctx**（沿用 cc-status 的 stale-ctx 铁律，`claude-code-tui.ts:411` 注释）。
- `disable()` / `session_shutdown`：kill 在飞子进程、清防抖句柄。

## 5. 渲染细节

### 5.1 D4 badge（第一行 belowEditor 最右）

- `badge = ⊙ <effort> · /effort`（09-22 起 CC 式 effort-only 芯片；effort 未设或为
  `off` 时整个省略——模型名已由脚本行承载）。muted 色，前缀空 2 列。`/effort` 是
  pi-claude-code-core effort 扩展注册的真实命令，提示可用。
- 拼装纯函数 `appendBadge(line, badge, width)`：`visibleWidth(line0) + 2 + wBadge ≤ width`
  才 pad+append；**放不下就整段省略**（绝不截断脚本输出）。line0 含 ANSI/全角——用现有
  `visibleWidth`（pi-tui）计宽，测试覆盖 ANSI + CJK + emoji 组合。
- statusline disabled 时 badge 不存在，model·effort 回 cc-status 右段（现状）。
- 开关 `statusLine.badge`，默认 true。

### 5.2 D0 完成行（`endRun`，`claude-code-tui.ts:678`）

现状：`✻ Baked for 1m 21s`，accent 高亮（`:436`）。改为：

- 色彩：accent → **theme dim**（CC 完成后灰化）。
- 内容：`✻ Baked for 1m 21s · 13:54`（时长=既有 `formatDuration(elapsed)`；结束时间 =
  `endRun` 时刻 `new Date(ts)` 取本地 `HH:MM`）。
- 抽纯函数 `buildCompletionLine(verb, elapsedMs, endTs)`（含 verb 随机——随机注入点收口
  在调用方，函数本身确定性，可 golden）。elapsed < 1000ms 不显示（现状阈值不变）。

### 5.3 cc-status 右段收敛

statusline enabled 时右组（model·effort │ Ctx │ $）整体收起——信息已由脚本行 + badge
承载；左半（spinner/verb/esc/pm stats）与 D0 完成行不动。disabled 时右组原样回归。

## 6. 默认脚本与配置

### 6.1 包内默认脚本（`scripts/statusline-default.sh`）

bash + jq（与用户脚本同依赖）；单行 `~dir │ ◆branch⇡⇣±n │ model │ Ctx p% (u/w) │ $cost`，
`$cost` 取 `.pi.cost_usd`（<0.01 显 4 位小数，否则 2 位——沿用 cc-status 规则）；色彩用
CC 调色常量（dir 白/git 青/model 橙/其余灰），支持 `OVERRIDE_TERM_WIDTH`。**不做**双行
自适应（默认脚本够一眼看；要花活请指到自己的脚本）。

### 6.2 命令解析（实现修订）

```
command = statusLine.command 非空 ? statusLine.command : DEFAULT_STATUSLINE_SCRIPT（内嵌脚本源码）
```

实现期发现：pi 的 jiti loader（`moduleCache: false`）一律从 data: URL 求值扩展文件，
`import.meta.url` 在生产安装下同样不可用——**默认脚本无法靠路径解析**。改为把脚本源码
内嵌（`lib/statusline-default-script.ts`，由 python json.dumps 逐行生成保证转义正确），
`bash -c` 直接吃源码；`scripts/statusline-default.sh` 保留为可编辑源 + bench 目标，
同步测试钉死两份逐字节一致。不自动嗅探 `~/.claude/statusline-command.sh`（避免惊喜行为）；
README 一行指路如何设置。

### 6.3 配置与 claude-tui.json 重构（**先行坑**）

现状 `saveToolRowsPref`（`claude-code-tui.ts:189-196`）**整文件覆写** `{toolRows}`——直接加
statusLine 键会互相抹掉。SL2 先做 read-modify-write：`loadPrefs()/savePrefs(partial)`（读
全量 → 合并 → 原子写 tmp+rename），toolRows 迁移到同一 store。

```json
{
  "toolRows": true,
  "statusLine": {
    "enabled": false,
    "command": "",
    "badge": true
  }
}
```

### 6.4 `/claude-statusline`

```
/claude-statusline                 ← 整体 on/off（回显当前 command 概要）
/claude-statusline on|off
/claude-statusline badge on|off
/claude-statusline set <command…>  ← rest-of-line 为命令，设完即触发一次刷新
```

## 7. 性能验证门（D1 的"看看会不会有性能问题"）

`scripts/bench-statusline.mjs`：对默认脚本与用户真实脚本各跑 50 次，量 p50/p95 wall time。

- **门限**：默认脚本 p95 < 50ms；用户脚本（bash+jq+git×N）p95 < 250ms。
- **推理兜底**（即使超标也不慌）：刷新只在会话事件发生（每 assistant 消息边界一次，
  分钟级频次），spawn 全异步不阻塞 render；TUI 帧路径零子进程。超标 → 仅记录 + README
  提示换默认脚本，不 block 发版。
- 结果数字写进 PR 描述（可复现命令一并给出）。

**实测 addendum（2026-09-22，实现后）**：默认脚本 p50 ≈ 30ms / p95 ≈ 50.0ms / max ≈ 97ms
（50 采样，本机负载下）；用户真实脚本 p50 ≈ 243ms / p95 ≈ 427ms。逐项拆解：`bash -c true`
≈ 35ms（fork 地板，本机负载下）、jq ≈ 7ms、`git status -b --porcelain` ≈ 21ms——因此
p95 门在 macOS 属「bash fork 决定论」，按既定策略记录不阻塞：刷新纯异步事件驱动，每次
落地 ~30ms 后 requestRender，用户不可感知。实现期优化已做：git 两次调用合并为单次
`status -b --porcelain`（branch+dirty 一次拿全）、默认命令改为 `bash '<path>'` 省 shebang
env 一跳（p95 从 279ms 降到 50ms）。

## 8. Phase 划分（ID 供测试引用）

| Phase | 内容 | 测试兜底 |
|---|---|---|
| SL1 | D0：`buildCompletionLine` + dim + endRun 接线 | golden（时长/时间格式、verb 确定性注入）；现有 cc-status 相关测试改期望色 |
| SL2 | 配置 store 重构（read-modify-write + 原子写） | round-trip：toolRows 与 statusLine 共存互不抹；坏 JSON → 默认值 |
| SL3 | `lib/statusline.ts`：`buildStatuslineJson` / `appendBadge` / runner | JSON schema golden（含降级）；badge 数学（ANSI/CJK/emoji/放不下省略）；runner 假子进程表驱动（防抖合并计数、in-flight 不叠、超时 kill、连续失败 3 次出错误行、行数上限） |
| SL4 | 渲染集成：applyFooterMode 双模式 × statusline on/off 四象限 + cc-status 右段收敛 + `/claude-statusline` | 四象限 golden 钉死行序 `[...sl, hints]`；disabled 象限 = v1.4.5 逐字节等价 |
| SL5 | 默认脚本 + bench + 文档（manual-verification.md 增 §9：四象限 + 真机脚本 + 窄屏 + 失败降级）+ README/CHANGELOG | bench 数字落档；CI 绿 |

流程沿用仓库惯例：每 Phase 红绿；SL4 完成后**红队对抗审查**一轮（自报"已修/已实现"必须
实测背书——见 Pi-Extension 主仓 2026-09-22 事故记录）；真机手动验收走 §9 checklist。

## 9. 爆炸半径分类

**等价类（改动必须逐字节保持）**
- statusline disabled（默认）：cc-status/cc-footer/footer slot 渲染 = v1.4.5 golden。
- native footer 双模式语义不变（`/claude-footer` 照旧）。
- D0 之外的 spinner 行为（tick 节奏、verb 轮换、pm stats）不变。

**纯性能类**
- runner 防抖/in-flight/超时：假子进程计数钉住（SL3）。
- UsageTracker 扩字段：仍是单次 O(branch) 扫描，无新遍历。

**功能类（新行为）**
- JSON 合成、badge 数学、四象限行序、失败降级行、命令与持久化。

## 10. 风险

- **claude-tui.json 并发写**：`/claude-tools` 与 `/claude-statusline` 同会话先后触发——
  read-modify-write + tmp+rename 后窗口极小，且两键互不覆盖（SL2 测试覆盖）。
- **脚本文本失控**（超宽/超多行/裸 ANSI）：行数上限 4；超宽不截断（wrap 责任在脚本的
  TERM_WIDTH 逻辑）；badge 放不下即省略。
- **jq 缺失**：默认脚本首行探测 `command -v jq`，缺则输出 dim `statusline: jq required`。
- **宽度变化风暴**（拖拽终端）：300ms 防抖 + in-flight，最坏 2 spawn/s 量级。
- **stale ctx**：runner 回调不触 ctx；badge 的 effort 读取在 render 内 try/catch（沿用
  `getThinkingLevel?.()` 现状写法）。
- **与 pi-mcp-adapter / pi-lens 无冲突**：不占 footer slot（belowEditor widget 归我们已有）。

## 11. 发版

v1.5.0（minor：新能力，无破坏；statusline 默认 off 保证零回归）。README 增「Statusline」
一节：协议、指向 `~/.claude/statusline-command.sh` 的示例、性能与依赖（bash+jq）说明。
