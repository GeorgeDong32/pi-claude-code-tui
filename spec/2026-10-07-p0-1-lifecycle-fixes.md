# 生命周期修复：非 TUI 守卫回归 · shutdown 收尾 · 启动头 stale ctx · 进程终止与计时器清理

日期：2026-10-07

状态：规格已补齐，待实施

范围：本仓库（`extensions/claude-code-tui.ts`、`extensions/lib/pi-startup-header.ts`、`extensions/lib/statusline.ts`）

来源：2026-10-07 core × cctui 联合架构审查，清单项 TUI-03 / TUI-04 / TUI-05 / TUI-06。后续由 `2026-10-07-p2-1-replica-session.md` 把这里的生命周期收进一个可测试的 module。

## 1. 基线与事实

| 对象 | 基线 |
| --- | --- |
| pi-claude-code-tui | 1.9.0，`7192d9f` |
| pi 依赖 | 1.0.1 |
| 本机加载顺序 | `pi-subagents → pi-claude-code-core → pi-claude-code-tui`（`~/.pi/agent/settings.json`） |

已确认的事实：

1. **非 TUI 守卫被误删。**
   - `b652fe0`（"packed events render in the conversation flow via CustomEntry"，1.9.0 之前最后一个 feature commit）删除了 `enable()` 中的 `if (ctx.mode !== "tui") return;`。
   - 而 `claude-code-tui.ts:739` 的注释仍写着 "TUI session active (non-TUI enable returned above)"。
   - `session_start`（`833-840`）对所有模式都调用 `enable(ctx)`。因此在 print / RPC 模式（`pi -p`、pi-subagents 子进程）下，现在会依次执行：
     - `channelActive = true`；
     - 发布 cctui 在场（`activateCcTuiChannel`）；
     - 启动 obs-savings 消费者，并把 packed 事件 `appendEntry` 进子会话文件；
     - 启动 subagent bridge；
     - 三处原型补丁（compaction / skill / user-bar）；
     - `setEditorComponent`、thinking tip `notify`；
     - 创建 statusline runner。
   - 只有 `applyFooterMode`（`563`）和 `applyPiHeaderLook`（`pi-startup-header.ts:276`）自带守卫。
2. **`session_shutdown` 收尾不完整**（`882-890`）。它只处理 run state、statusline runner、editor 计时器、working indicator，**没有**：
   - `subagentBridge.stop()`——`subagent-presentation.ts:423` 的文档明确写着 disable / session_shutdown 都应调用；
   - `withdrawCcTuiCapability()`：在场标记 `__piCcTui` 残留；
   - `stopObsSavingsConsumer()`；
   - 卸载启动头（`disposePiHeaderLook` / `setHeader(undefined)`）。
3. **在场标记残留的后果**：
   - (a) `/reload` 之后，core 在 `session_start` 期间发出的通知没人显示——core 看到残留的在场与 consumer 声明，既不自显也不转发。见审查目录 `sims/reload-core-first-sim.mjs`，按本机加载顺序复现。
   - (b) 若 `git pull` + `/reload` 后本包加载失败（这正是本仓库的标准发布流程），core 的 working 行、modes footer、全部通知将永久静默。
4. **启动头在 render 中直接访问捕获的 ctx**（`pi-startup-header.ts:213-226`）：每帧读取 `this.ctx.ui.theme`、`this.ctx.model`、`this.ctx.cwd`，没有 try/catch。
   - 这是本包唯一违反 AGENTS 坑 1（render 不得抛）与坑 3（ctx 会过期）的 render 路径。
   - 本包自己的注释（`claude-code-tui.ts:417-421`）认定 stale ctx 访问会抛错并杀死 pi；叠加事实 2（shutdown 不卸载 header），会话替换窗口内的一帧即可触发。
5. **statusline runner 的三个计时器没有 `unref()`**（`statusline.ts:231` debounce、`292` SIGTERM 超时、`300` SIGKILL 升级），违反坑 11；仓库其余计时器都已 unref。
6. **dispose 取消了终止升级**（`statusline.ts:247-261`）：先 clear killTimer，再只向 child 发 SIGTERM；忽略该信号的脚本不会收到正常 timeout 路径的 SIGKILL。独立审查以真实 StatuslineRunner + 不退出的 fake child 复现，dispose 后只有 SIGTERM。因此有界终止是本次需要新增的行为，不能说“保留既有保证”。

## 2. 目标与约束

### 2.1 必须实现

- 非 TUI 模式下，不启用 UI、在场、订阅、bridge、patch、外部进程或写显示 entry。加载期 renderer/命令注册保留，resolver 原样让路；不把“零注册”当验收。
- `session_shutdown` 撤回在场、释放 UI / 订阅 / 待执行任务，并对 runner 直接持有的子进程启动有界终止流程（§4.4）；不宣称能回收任意脱离的后代进程。
- 本次修改的 header/render 路径不访问捕获的 ctx；其余已使用缓存的 render 行为保持。
- 所有计时器 unref。

### 2.2 显示层红线

不改任何工具 `execute`、不改发给模型的内容。本 spec 只动生命周期与渲染保护。

### 2.3 不做的工作

- 不重构入口结构（见 P2-1）。
- 不改通知 / obs 的订阅算法（见 P0-2）——但本 spec 的 shutdown 撤回是 P0-2 的前提之一。
- 不改 prefs 文件、命令与开关语义。

## 3. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 |
| --- | --- | --- | --- | --- | --- |
| N1 | 非 TUI 模式做什么 | A **什么都不做**（包括在场与 obs entry）；B 只保留 obs entry 记录（日后在 TUI 中 resume 可见）；C 只保留在场 | **A** | B：子会话里的 packed 记录（子会话很少在 TUI 中打开） | 若 b652fe0 有意在非 TUI 下记录 entry，请在 review 时指出，改选 B |
| N2 | shutdown 的收尾范围 | A **资源 + 在场 + header**（不改 UI 槽位）；B 与 disable 完全相同（包括恢复 footer / widget 槽位）；C 维持现状 | **A** | B：退出时恢复 UI 槽位没有意义，且槽位由下一个 session 重设 | 无 |
| N3 | 原型补丁在 shutdown 时 | A **撤回**（`PrototypeMethodAdapter` 只撤自己仍拥有的改写，安全）；B 保留，靠重装时的 marker 刷新 | **A** | B 少几次调用 | 无：下一个 session 的 enable 会重新打补丁 |
| N4 | 启动头的数据来源 | A 构造时快照；B **入口注入 getter（模型名、cwd）+ 使用 setHeader 工厂传入的 theme，读取失败回落 last-good**；C 仅加 try/catch | **B** | A 切换模型后 header 不更新；C 保留了对 ctx 的依赖 | 无 |

## 4. 设计

### 4.1 非 TUI 守卫（TUI-03）

- `session_start` handler 开头：`if (ctx.mode !== "tui") return;`——包括它当前在 `enable` 之前做的 `observeUsage`、通知 / obs 重试。
- `enable()` 开头补上同样的守卫（`/claude-tui` 命令也会调用 enable）。
- 修正 `739` 的注释。

### 4.2 共享 teardown（TUI-04）

新增入口内函数 `teardownSession(ctx, reason: "disable" | "shutdown")`，先关闭 channelActive/enabled、递增 session generation，阻止释放过程重入启动。之后按以下顺序执行，**每个释放调用独立 try/catch**（同一条中的两个调用也不能互相阻断）：

0. 取消 `applyFooterMode` 安排的 setTimeout(0) 重注册；回调另检查 generation 和 `!showNativeFooter`。旧 callback 不能因为新 session 的 enabled=true 而使用旧 ctx。
1. `subagentBridge.stop()`
2. `stopObsSavingsConsumer()`
3. `withdrawCcTuiCapability()`（内部会停止通知消费者）
4. `teardownStatusline()`、`runState.halt()`
5. `activeEditor?.release(); activeEditor = null`
6. `disposePiHeaderLook()`；仅当 `ctx.mode === "tui"` 时调用 `ctx.ui.setHeader(undefined)`
7. `restoreCompactionRow()`、`restoreSkillRow()`、`restoreUserBarPatch()`
8. 清空 `latestCtx` / `dockTui` / header getter 的旧会话引用；状态释放幂等。旧实例 withdraw 只删除自己持有的在场对象，不得撤回新实例。

`disable(ctx)` = `teardownSession(ctx, "disable")` + 现有的 UI 槽位恢复（`setFooter` / `setWidget` / `setWorkingVisible` / `setHiddenThinkingLabel` / `setWorkingIndicator` / `setWorkingMessage`）。

`session_shutdown` = `teardownSession(ctx, "shutdown")` + 现有的 `setWorkingIndicator()` / `setEditorComponent(undefined)`（各自容错）。

所有非 TUI 事件 handler 同样遵守 session 是否激活的守卫；仅保护 session_start 不足以防住 model_select/agent_start 等后续事件。session_start 若收到新上下文而旧实例尚活跃，先 teardown；重复 enable 同一 generation 幂等，不重复 tips、订阅或计时器。

### 4.3 启动头（TUI-05）

- `applyPiHeaderLook(pi, ctx, getters)` 新增参数 `getters = { modelLabel(): string, cwd(): string }`。入口提供它们：模型名取 `currentModelName`，由 `model_select` 维护；cwd 取 enable 时的 `ctx.cwd` 快照。
- `PiStartupHeader` 不再保存 `ctx`：
  - theme 使用 `setHeader` 工厂传入的 theme 参数（本地 pi 1.0.1 类型明确提供 theme，无需猜测；theme 变化由宿主重建或惰性安全 adapter 刷新）；
  - `render` 整体包 try/catch，失败时返回按当前 width 截断的 last-good；没有 last-good 时返回安全纯文本。宽度缩小时不能原样返回超宽旧帧。
- `tipCommands` 已在构造时计算，不变。

### 4.4 计时器（TUI-06）

`statusline.ts` 的 debounce、timeout、SIGKILL 升级及 dispose 升级 timer 全部 `.unref?.()`；它只影响宿主事件循环是否被保活，不能替代取消或终止进程。

- `dispose()` 首先标记终态，取消 debounce、清空 pending refresh / onUpdate；之后的 request 和迟到 settle 不重启进程、不更新 UI。
- 对当前 child 捕获独立 run token，将其从可调度状态摘除；若尚未发 TERM，立即尝试 SIGTERM，再安排 750ms 后的 SIGKILL。若正常 timeout 已进入 TERM→KILL 阶段，保留原升级截止时间，不因 dispose 或重复 dispose 延后或取消。
- 升级回调只持有该次 child/token，不能读取可能已经属于新会话的 runner 状态。child 已退出则不再 kill；TERM 抛错或返回 false 不能让 teardown 抛出，也不能无证据地把仍存活 child 当成已回收。
- exit（或可确定未成功创建进程的 spawn error）清理该 run 的 timer 与监听资源；普通 error 不等于已退出，仍须完成终止流程。stdout/stdin 等回调在 disposed 后不再积累输出或触发 onUpdate。重复 dispose 幂等，不能清掉仍必要的升级 timer。
- 这里的有界保证是在宿主仍运行、事件循环得到调度时，最迟于 TERM 后 750ms 尝试对该 child 发 SIGKILL；不是同步等待退出，也不保证操作系统拒绝 kill 时仍能回收。沿用现有 `bash -c` 的直接 ChildLike 范围，不承诺杀掉独立后台进程或整棵进程树。进程组策略如需改变，应另立规格。

## 5. 测试

| # | 用例 | 位置 |
| --- | --- | --- |
| E1 | `ctx.mode = "rpc"` 时触发 `session_start`：不写 `__piCcTui`、不调用 `appendEntry`、不注册原型补丁（adapter 的 patched 状态为 false）、`notify` 0 次 | 新文件 `test/entry-lifecycle.test.ts`，使用最小 fake pi / ctx |
| E2 | TUI 模式 `session_start` → `session_shutdown`：`__piCcTui` 被删除；bridge 收到 stop；obs / 通知订阅被取消；header 被 dispose | 同上 |
| E3 | `session_shutdown` → 再次 `session_start`（同一模块实例，模拟 `/new`）：在场被重新声明，订阅重新建立，补丁重新安装 | 同上 |
| E4 | 启动头：构造后旧 ctx getter 全部设为抛错，render 不再读取它；注入数据 getter / theme 失败时 `render(80)` 不抛，并返回 last-good；切换模型后 header 显示新模型名 | `test/pi-startup-header.test.ts` |
| E5 | statusline：每个实际创建的 debounce / timeout / 正常升级 / dispose 升级 timer 都 unref；取消后不能再启动进程 | `test/statusline.test.ts` |
| E6 | session_start → 安排 requeue → shutdown/new/native footer 切换 → 执行旧 callback：零旧 ctx 访问、零 widget 重装；某一步 teardown 抛错，其余全部完成 | entry-lifecycle |
| E7 | 忽略 TERM 的 child：dispose 后先 TERM、750ms 后 KILL；重复 dispose 不取消或延后；已发 TERM 后 dispose 保持原截止时间 | `test/statusline.test.ts` |
| E8 | child 提前 exit / spawn 失败正确清理 timer；kill 抛错不泄漏异常，普通 error 不冒充已退出；dispose 后迟到 data/exit/error 零 onUpdate、零 respawn，新 runner 不受旧回调影响 | 同上 |

E1 / E2 / E4 / E7 在当前代码上应为红，提交前确认并记录。计时器用可控 scheduler（真实和 fake 两个 adapter），不靠真实 sleep；入口测试加载真实 factory 并只替换宿主依赖，不能只测新 helper 而漏掉注册接线。

## 6. 完成定义

- `npm test` 与 `npm run typecheck` 双绿。
- 手动验证（补进 `docs/manual-verification.md`）：
  - `pi -p "hello"` 输出无 thinking tip，子会话文件中没有 `cc-tui/observation-packed` entry；
  - TUI 中执行 `/reload` 后，一条可重复触发的 core 配置告警能显示（隔离测试配置，退出后清理）——与 P0-2 联合验证，不假定不存在的 CLI flag；
  - `/claude-tui off → on` 一切正常。
- `CHANGELOG.md` 新增条目（fix：非 TUI 模式恢复为 stock；退出时释放资源并保留对子进程的终止升级）。
- `AGENTS.md` 坑 3 补一句："header 也不得在 render 中访问 ctx"。

## 7. 代码依据

- `extensions/claude-code-tui.ts:705-797`（enable / disable）、`833-840`（session_start）、`882-890`（session_shutdown）、`739`（过时注释）
- `extensions/lib/pi-startup-header.ts:179-226, 275-289`
- `extensions/lib/subagent-presentation.ts:423`
- `extensions/lib/statusline.ts:221-235, 264-307`
- `git show b652fe0 -- extensions/claude-code-tui.ts`

---

## 8. 实施记录（2026-10-07）

状态：自动化部分已实施（commit 见 git log）；真机验证项保持 open（docs/manual-verification.md §11）。

- §4.1/§4.2/§4.3/§4.4 全部落地：非 TUI 守卫回到 `session_start` 与 `enable()` 开头；`teardownSession(ctx, "disable"|"shutdown")` 按 8 步顺序逐项容错；启动头改为 `HeaderDataGetters` + setHeader 工厂 theme + last-good 回退（宽度截断）；statusline 计时器全部 unref，dispose 走 TERM→750ms KILL，保留既有升级截止时间。
- 事件 handler（before/compact/compact_failed/message_end/model_select/agent_start/agent_settled/session_tree）均补 `if (!enabled) return;` 守卫。
- 顺手并入 P3-1 的 D7（stdin 写 `activeInput`）与 D5 注释（macrotask 尽力排序说明 + generation/native 检查），D5 的真实宿主顺序取证仍未做，保持 todo。
- 测试：`test/entry-lifecycle.test.ts`（E1/E2/E2b/E3/E6/E6b/E6c，真实 factory 接线）、`test/pi-startup-header.test.ts`（E4 ×3）、`test/statusline.test.ts`（E5/E7/E8 ×10，注入 `RunnerScheduler` 可控时钟 + 忽略信号的 fake child）。红基线已取证：stash 生产代码后 E1–E6c 7 红、E4 3 红、E7/E8 7 红；修复后 211 测试全绿 + tsc 0 错。
- 边界确认：KILL 保证范围仅 runner 直接 child（`bash -c`），不声称回收脚本自衍生的后台进程树；非 TUI 模式零注册面之外的行为（resolver/entry renderer/markdown transformer 加载期注册保留，resolver 原样 `next()`）。
