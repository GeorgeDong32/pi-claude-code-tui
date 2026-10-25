# STATUSLINE-PERF-PLAN — 默认渲染进程内化（提案 · 草案待批）

> **存档说明**：SP1–SP3 已全部落地（bf57684 / 1f32324 / ef7d703 + unborn 修复 8ac597f，测试绿）。
> 本文档保留为设计决策存档；当前行为以代码与 CHANGELOG 为准。实机验证补充：默认路径
> 6 turn 零 fork（scoped 采样 0）；unborn 分支字节分歧由实机探针发现并修复（金测矩阵盲区）。

> **状态：草案**——2026-10-25 泄漏深度扫描的优化产出（报告 /tmp/leakscan/leak-deep-scan-report.md P1）。
> 等用户批准后按 Phase 执行；批准前不动任何代码。

日期：2026-10-25 ｜ 基底：当前 main（6562336）

## 0. 背景与动机

- **现状**：每次会话事件 → `StatuslineRunner` spawn `bash -c`（bash + jq + git 子进程链），
  默认脚本 p95 ≈ 50ms（其中 bash fork 地板 ~35ms，本机实测）。
- **深扫发现**：每 turn **≥2 次**刷新触发——`message_end` 与 `agent_settled` 都走
  `onUsagePoint` → `refreshStatusline`（replica-session.ts:430-433）；每次 spawn 伴随
  `{...process.env}` 整环境拷贝、双端管道、JSON 序列化。无泄漏（leaks 432B、heap 保留
  0.13M/turn 全为 JIT 代码对象），但属于纯浪费的 churn：**默认配置下每 turn 0-2 个子进程链
  可以是 0 个**。
- **目标**：默认命令（`statusLine.command` 为空）路径消灭子进程，渲染延迟 ~50ms → <1ms；
  自定义命令路径（CC 脚本协议兼容 seam）**逐字节不动**。

## 1. 决策表

| # | 决策 | 备选与拒绝理由 |
|---|---|---|
| D1 | **command 为空 → 进程内渲染**；非空 → 现有 spawn 路径原样 | ❌ 全面替换 runner：破坏 CC 用户脚本零改动复用（rev3 D1 初衷）；❌ 常驻进程协议：rev3 design-it-twice 已拒 |
| D2 | **git 段分层（对标 CC `gitFilesystem.ts` 设计，用户指示对标 `/Users/gd32/Coding/claude-code/src/utils/git/gitFilesystem.ts`）**：<br>**D2a branch** = 零 spawn，直接读 `.git/HEAD` + loose ref + packed-refs 兜底，`watchFile` 盯 `.git/HEAD`/`.git/config`/当前分支 ref 三文件精确失效，切分支重挂 watcher——分支/提交变化**即时**反映<br>**D2b dirty 计数** = 异步 `execFile('git', ['status','-b','--porcelain'])` + TTL 10s 兜底 + `.git/index` mtime watch **提前失效**（工具落盘/暂存即重算）；渲染立即用缓存值，git 落地后 `requestRender` 补一帧 | ❌ 原纯 TTL 方案（已废弃）：切分支/提交最多陈旧 10s，且 branch 也要等 fork；❌ 砍 git 段：信息损失；❌ dirty 计数文件系统化：等于重写 `git status`（index 二进制解析+全树 stat），不现实；❌ fs.watch 目录树：过度工程 |
| D3 | **刷新合并**：`agent_settled` 与 `message_end` 的双触发在 session 层合并为每 turn 至多一次 dirty 标记（250ms debounce 保留兜底） | 现状靠 debounce 概率性合并——时序近则并、远则两次 spawn |
| D4 | **字节级 parity 金测**：TS 渲染器与 bash 默认脚本对同一 JSON 输入矩阵输出逐字节一致；脚本保留为参考实现 + parity oracle | ❌ 删脚本只留 TS：失去 oracle，漂移不可检 |
| D5 | 逃生口 `statusLine.forceScript: true` 强制走 spawn（调 parity / 排障用） | — |

## 2. 现状架构回顾（改动点标注）

```
事件(message_end/agent_settled/model_select/compact/宽度/命令变更)
  → ReplicaSession.onUsagePoint → refreshStatusline()          ← 【D3 合并点】
  → StatuslineRunner.request(buildStatuslineJson(...), w)      ← JSON 已在进程内算好
  → [250ms debounce] → spawn bash -c <默认脚本|用户命令>         ← 【D1 绕过点(默认)】
      bash: jq 解析 + git status -b --porcelain + 拼行          ← 【D2 迁移点(git)】
  → splitStatuslineOutput → footer 渲染
```

改动只在「默认命令」分支：`buildStatuslineJson` 产物直接喂新纯函数渲染器出行；
git 段走 GitStatusCache。runner/spawn/防抖/超时/失败降级代码零改动（自定义命令继续用）。

## 3. 新模块设计

### 3.1 `lib/statusline-renderer.ts`（SP1，纯函数）

- `renderDefaultStatusline(input: StatuslineInput, width: number): string[]`
  移植默认脚本全部格式化逻辑：`~dir │ ◆branch⎇±n │ model │ Ctx p% (u/w) │ $cost`
  单行拼装、CC 调色常量、`OVERRIDE_TERM_WIDTH` 等价的宽度自适应、cost 位数规则
  （<0.01 显 4 位小数否则 2 位）、jq 缺失降级行（进程内路径恒有数据，此分支成为
  forceScript parity 专用）。
- git 段入参为 `GitSegment | null`（null = 无仓库/detached → 省略该段），由调用方从
  GitStatusCache 取——渲染器本身不触进程、不触 fs，**完全可 golden**。

### 3.2 `lib/git-segment-provider.ts`（SP2，对标 CC gitFilesystem 的最小移植）

只移植 branch 单 key（CC 原版 699 行含 remote-url/default-branch/symref 链，我们不需要），最小面 ≈200 行：

```ts
interface GitSegment { branch: string; dirty: number }
class GitSegmentProvider {
  get(cwd): GitSegment | null      // 立即返回缓存（branch 部分可能已由 watcher 置脏→同步重读文件）
  refreshDirtyIfStale(cwd): void   // TTL 10s 外才发 execFile；in-flight 去重
  //                                 index-mtime watcher 触发时提前失效（不等 TTL）
}
```

**branch 路径（零 fork，CC 同构）**：
- `resolveGitDir`：向上找 `.git`（目录或 file 形态——worktree/gitbutler）
- `readGitHead`：`ref: refs/heads/x` → 分支名；sha → detached（省略段）
- loose ref 缺失 → packed-refs 解析兜底（含 `^peeled` 行跳过、UTF-8 分支名路径）
- `watchFile(HEAD/config/当前分支 ref)` → 全 cache 置脏；HEAD 变化 → 重挂分支 ref watcher；
  watcher 对不存在的文件也有效（新分支首提交触发）
- **竞态纪律照抄 CC**：compute 前清 dirty，compute 中文件再变则 dirty 回置，下次 get 重读

**dirty 路径（异步 fork，仅此一处）**：
- TTL 10s 兜底 + `.git/index` mtime watch 提前失效——工具改文件/`git add` 即刻重算；
  untracked 新文件不改 index，靠 TTL 覆盖（≤10s 陈旧，与原方案一致）
- 错误（git 缺失/超时 2s）→ 静默保持现值，行为对齐 bash 的 `2>/dev/null`

- 异步纪律沿用铁律：回调只写缓存 + `dockTui?.requestRender()`，render() 内绝不触 ctx。

### 3.3 ReplicaSession 接线（SP2-SP3）

- `refreshStatusline()` 分叉：`command === "" && !forceScript` → 进程内路径
  （`renderDefaultStatusline` + `cache.refreshIfStale` + 直接 setLines）；
  否则原 `statuslineRunner.request` 不动。
- D3 合并：`onUsagePoint` 改置 dirty 标记，microtask/setImmediate 末尾统一 flush 一次
  （同一 turn 的 message_end + agent_settled 天然合并）。

## 4. Phase 划分（ID 供测试引用）

| Phase | 内容 | 测试兜底 |
|---|---|---|
| SP1 | `statusline-renderer.ts` 纯函数移植 | **parity 金测矩阵**：同一 JSON 输入 → TS 渲染器 vs `bash statusline-default.sh` 输出逐字节一致；矩阵含：正常仓库/gitless/detached/超宽截断/极窄/cost 边界（0/0.009/0.01/1.5）/空 model/win=0 |
| SP2 | `git-segment-provider.ts`（branch 文件系统层 + dirty TTL 层）+ session 接线（默认路径绕过 runner） | 假时钟表驱动：TTL 内 0 次 execFile、过期恰好 1 次、in-flight 去重、错误静默保缓存；branch 金测用本机真实仓库样本（regular/worktree/gitbutler/packed-refs/detached）；接线后四象限（statusline on/off × native footer on/off）golden 不变 |
| SP3 | D3 刷新合并 + bench 扩展 + 文档 | 双事件同 turn 只 1 次渲染（计数钉死）；`bench-statusline.mjs` 增 in-process 模式；CHANGELOG/README/manual-verification §9 增补；对抗审查一轮（仓库惯例） |

## 5. 性能验证门

| 指标 | 门限 | 测法 |
|---|---|---|
| 进程内渲染 p95 | **< 1ms**（50 采样） | bench 新模式 |
| git branch 段 | 0 fork，watcher 驱动**即时**（切分支/新提交 <1 个 watch interval 反映） | 表驱动 + 本机 golden |
| TTL 失效刷新 | 单 git fork ≈ 21ms，异步不阻塞 | bench |
| 每 turn spawn 数（默认路径） | 2+ → **0**（git 未过期时） | 集成计数 |
| parity | 逐字节一致 | SP1 金测矩阵 |
| 可选回归 | 泄漏探针配方 steady-state footprint 斜率对比（预期自 ~0.5M/turn 下降） | /tmp/leakscan 配方 |

## 6. 爆炸半径分类

**等价类（逐字节保持）**
- 自定义 `statusLine.command` 路径：runner/spawn/防抖/超时/失败降级全不动（golden 已有）。
- statusline disabled 四象限 = 现状 golden。
- native footer 双模式语义（`/claude-footer`）。

**纯性能类**
- 默认路径渲染来源：bash 子进程 → 进程内纯函数（parity 金测兜底）。
- 刷新合并：只减触发次数，不改渲染结果。

**功能类（新行为）**
- `statusLine.forceScript` 逃生口（默认 false）。
- git 段新鲜度：branch **即时**（watcher 驱动，切分支/新提交立刻反映）；dirty 计数
  **≤10s 陈旧窗口**（仅 untracked 新文件场景——tracked 改动/暂存由 index-mtime watch
  即时触发）。这是用户可见的唯一语义变化，README 注明。

## 7. 风险

- **TS/bash parity 漂移**：脚本保留为 oracle；现有「内嵌脚本 vs .sh 逐字节一致」测试
  扩为三方（embedded / .sh / TS 渲染输出）；改任何一侧先跑 parity。
- **git 边角**（worktree、gitbutler 虚拟 ref、detached、中文分支名、packed-refs）：branch 解析
  照抄 CC 已验证逻辑（resolveGitDir file-form worktree / readGitHead / packed-refs 兜底），
  golden 样本取自本机真实仓库输出。
- **execFile 错误路径**：git 二进制缺失 → 静默隐藏 git 段（对齐 bash `2>/dev/null`）。
- **bench 门超标的推理兜底**：刷新事件驱动、渲染异步，超标记录不阻塞（沿用 §7 原则）。

## 8. 发版

minor（默认路径行为优化 + 新配置键，无破坏）。CHANGELOG 注明 git 段 10s 陈旧窗口。
