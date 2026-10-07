# core-bus client：通知所有权交接 · bus 更换重挂 · footer 渲染

日期：2026-10-07

状态：规格已补齐，待实施

范围：本仓库 `extensions/lib/`（新增 `core-bus.ts`，改造 `pm-capability.ts`、`obs-savings.ts`）、入口接线、`lib/statusline.ts` 的 footer 组合

配对：pi-claude-code-core `spec/2026-10-07-p1-1-bus-surface-for-cctui.md`。core 提供 `snapshot.instance`、登记协商语义 XPKG-01/02/03/07，并把经济模块降级提示的 `display.footer` 发布挪进事件处理器。core 先落地或同日落地；本 spec 在旧 core 上也能工作（§5）；不依赖 core D4 的 reader 删除提案。

前置：`2026-10-07-p0-1-lifecycle-fixes.md`——shutdown 撤回在场。

## 1. 基线与事实

### 1.1 三个运行时复现

审查目录 `sims/` 中的脚本用 Node 24 直接 import 两个仓库的真实 `bus.ts` 与 `pm-capability.ts`，用 `?query` 模拟 jiti `moduleCache:false` 产生的新实例：

| 场景 | 脚本 | 结果 |
| --- | --- | --- |
| cctui 先于 core 加载，`/reload` | `reload-sim.mjs` | 新实例 attach 到旧 bus（旧快照仍挂在 `globalThis` 上，直到新 bus 首次 publish）；之后每次重试都因 `notifyUnsubscribe` 非空而短路 → 重载后的通知全部丢失 |
| cctui 先于 core 加载，首次启动 | `startup-window-sim.mjs` | 在场先声明，attach 失败（v1 快照无 `onChange`）；core 在 session_start 发的通知被 fallback 跳过、notify 也不转发；cctui 下一帧 attach 时 fast-forward 越过它 → 丢失 |
| **本机顺序** core 先于 cctui，`/reload` | `reload-core-first-sim.mjs` | 旧实例的在场标记没有被撤回（shutdown 不 withdraw，见 P0-1），core 的 session_start 通知面对残留的在场标记 → 无人显示 |

被吞掉的恰恰是用户最需要看到的配置告警：
- core `effort/index.ts:212-235`：`--effort` 参数错误、`PI_CORE_EFFORT` pin；
- core `modes/profile-apply.ts:116-128`：model-profile 恢复失败——"Model not found in registry" / "No API key available"。

### 1.2 现状结构

- `pm-capability.ts:136-198`（通知）与 `obs-savings.ts:32-100`（packed sites）各自实现了一遍相同的结构：读取 `__piClaudeCodeCore` → 取 `onChange` → 模块级单例订阅 → 幂等 attach。真正不同的只有约 10 行 diff / dedupe。
- 重试点：`enable`（`claude-code-tui.ts:714-715`）、`session_start`（`837-838`）、cc-status 每帧 render（`415-416`）。
- 注释"Load order puts cctui before core"（`pm-capability.ts:139-140`、`obs-savings.ts:12`、`claude-code-tui.ts:836`）与本机实际顺序相反。实际上两种顺序都必须正确。
- obs-savings 的 `sitesKey`（`56-58`）不含 `toolCallId`；`stop → start` 会把 `lastKey` 重置为 null，于是下一次无关的 publish 会把快照里持久保留的 sites 再投递一次，造成 packed entry 重复。
- core 发布的 `display.footer`（经济模块降级提示）目前无人渲染。用户决定（D5）："footer 以 TUI 为准"——cctui 持有 footer 槽时由 cctui 渲染。

### 1.3 core 侧协商规则（不改）

- `ui/notify.ts:59-68`：cctui 在场且声明了 consumer 时，core 不做 direct forward。
- `ui/fallback.ts:47-61`：cctui 在场时，fallback 只推进游标、不显示。

因此：**在场声明的那一刻就是通知所有权的交接点。** cctui 必须尝试消费交接后仍在 cap 20 尾队列里的每一条；溢出或单条显示失败的边界见 §2.1 / §4.2，不能承诺任意迟到下零丢失。

## 2. 目标与约束

### 2.1 必须实现

- 两种加载顺序、首启、reload/new/off→on 中，交接后仍在 cap 20 队列里的通知，在成功显示路径上恰好一次；fallback 已显示的历史不重复。没有 ACK 的尾队列不承诺订阅前超过 20 条的历史可恢复。
- bus 实例更换后自动重挂。
- packed sites 不重复投递已见批次；交接至 attach 之间最新可见的新批次应立即消费。sites 仅保留最后批次，被后续批次覆盖的历史无法补回，本 spec 不增加持久事件日志。
- cctui 启用时渲染 `display.footer`，包含 native footer 模式的 cc-footer；显式 off 恢复 stock，不承诺自动交回 core。

### 2.2 显示层红线

不改模型可见内容；packed entry 仍是 display-only 的 CustomEntry。

### 2.3 不做的工作

- 不改 core 的协商规则。
- 不引入定时器或轮询——复用生命周期/渲染事件重试，native footer 下也有活跃重试点。
- 不改 `readPmStatus` 的降级链（mode / workingStats / meta）。

## 3. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 |
| --- | --- | --- | --- | --- | --- |
| B1 | 修复位置 | A 在两个模块里各自打补丁；B **新增 `lib/core-bus.ts`，两个消费方退化为 adapter** | **B** | A 的改动面更小，但同一缺陷要修两遍，第三个 channel（footer）又会复制一遍 | 无 |
| B2 | 如何检测 bus 更换 | A 只比较 `onChange` 函数身份；B **优先比较 `snapshot.instance`（core P1-1），缺失时回退函数身份** | **B** | — | 旧 core 下函数身份同样可靠：同一 bus 每次 publish 都复用同一个 register 闭包（core `bus.ts:124-158`） |
| B3 | 通知游标的起点 | A attach 时 fast-forward 到最新（现状）；B 从 0 开始；C **在场声明时记录"当前队列最大 id"；attach 时，若仍是声明时的那个 bus 实例，就从该 id 开始，否则从 0 开始** | **C** | A 会丢交接窗口内的通知；B 会重复显示 fallback 在声明前已显示过的条目 | 无 |
| B4 | 在场的生命周期 | A 只在 disable 时撤回（现状）；B **shutdown 也撤回（P0-1），session_start 重新声明** | **B** | — | 在 shutdown 与下一次 session_start 之间，core fallback 会自己显示通知，不丢失 |
| B5 | obs 去重 | A 维持 id+tokens；B **key 含 tool/id/toolCallId/avoidedTokens；基线取自 declarePresence，不能在延迟 attach 时重新截断** | **B** | — | off 期间与早于接管的历史不补写；见 §4.2 |
| B6 | footer 放在哪 | A 合入 hints 行；B **作为独立的 dim 行，放在 statusline 行之后、hints 行之前**；C 用 notify 闪显 | **B** | C 的零布局改动 | footer 多一行，只在 core 降级时出现 |

## 4. 设计

### 4.1 `lib/core-bus.ts` 的 interface

```
createCoreBusClient({ store, adapters }) → {
  activate(): void  // 同步采集交接基线、声明在场、retry；重复调用幂等
  retry(): boolean  // 检测当前有效 v2+ onChange / 实例身份，必要时重挂
  close(): void     // 幂等退订、撤回自己拥有的在场、清空本 client 状态
}
```

adapter 为 `{ onAttach(snapshot, handoff), onSnapshot(snapshot), onDetach() }`，生产的通知/obs/footer 和测试的录制 adapter 跨同一 seam。客户端统一持有 instance、register、unsubscribe 与 generation；不让三个消费方再各管一份订阅生命周期。

**接管顺序（同一同步段，无 await）：**采集当前快照身份、通知 max id 与 obs keys → 写带 owner identity 的 presence 对象/legacy key → 尝试订阅 → **立即处理当前快照**。onChange 不会自动回放当前状态，不能等下一条无关 publish 才补交接窗口。重复 activate 不重置基线或游标。

**身份与清理：**有 instance 时优先比较 instance，无字段时比较 register 函数引用；v1 或无 onChange 不订阅。subscribe / unsubscribe / getter / adapter 任一失败都不得抛到宿主；订阅失败保持可重试。换 bus 时先使旧 generation 失效，再退旧订阅、重挂；旧 callback 即使迟到也不能拿全局新快照投递。close 只撤回自己发布的 presence 对象，不能删除新实例的标记；legacy key 随同一 ownership 判断删除。

core v2+ 尚未出现时保留交接基线等待 retry。更早的无尾队列 core 若支持直接通知转发，保留旧兼容路径；不能在其直接转发同时重放同一历史。所有回退须用明确 capability fixture 覆盖，不能仅以版本字符串猜测。

### 4.2 adapter 规则

| adapter | attach / 增量规则 | 失败语义 |
|---|---|---|
| 通知 | 同 bus 从 presenceCursor 增量；换 bus 从 0。attach 立即消费当前队列，再按 id 增量。每次读取验证数组与 item 形状 | 沿用现状：尝试 display 前推进游标，单条失败不阻塞后续、不无限重放；不承诺该条成功展示 |
| packed sites | activate 记录既有 sites 为历史基线；attach 时与此基线比较，立即投递窗口内最新新批次。key 用 JSON tuple 编码，包含 tool/id/toolCallId/avoidedTokens，不拼可碰撞的冒号串 | 失败吞掉并标记本批已尝试；后续不同批次正常处理 |
| footer | attach 即读 display.footer；变化后更新只读缓存、requestRender；缺失/新 bus 无字段则清空，不能沿用旧 bus 文本 | 非数组/非字符串过滤；渲染按宽度截断且不抛 |

obs 去重以 **当前 session/branch** 为域；/new 清空，不让上一会话的 toolCallId 误抑制下一会话。reload/resume 时在事件路径扫描一次当前 branch 的 `cc-tui/observation-packed` entries 建立已显示 key 集合；不在 render 扫 history。新 bus 上相同已显示 site 不补写；同 id 不同 toolCallId 仍可分别显示。off→on 时当时已有的快照作为历史基线，off 期间不追补。

通知尾队列与 obs latest-batch 是不同协议，不能用一个 fast-forward 算法兼任。cap 溢出、callback 失败与已经覆盖的 obs 批次要在文档说明，不新增伪成功 ACK。

`readPmStatus` 继续纯读且回退链不变。

### 4.3 入口接线

- enable：先设置本会话的通知 sink 与 obs session identity/去重集合，再 `client.activate()`，避免立即 attach 的回调写入旧 session。
- session_start、cc-status render、**cc-footer render** 均可调用幂等 retry；native footer 会卸载 cc-status，不能把恢复订阅完全寄托于它。model/usage 等现有事件也可触发 retry，不引入额外轮询 timer。
- teardownSession：先使 session generation 无效，再 client.close；每步单独容错（P0-1）。
- cc-footer：`composeFooterLines({ ..., coreFooter })`，footer 行在 script 后、hints 前。native footer 模式下 cc-footer 仍在，继续显示 coreFooter；/claude-tui off 后不保留 cctui widget，`setFooter(undefined)` 恢复宿主 stock footer，不显示 coreFooter。
- native footer 开启时 cc-status 虽不 render，footer 缓存与通知/obs 仍会重挂。无 core 时新参数默认空数组，旧 golden 不变。

**槽位归属边界：**presence 只用于协商，不是 footer 栈。core 仅在 session_start 尝试安装 modes footer，withdraw 不触发重新安装；所以 off 后不会自动恢复 core footer。维持现有 off 语义，不新增交回协议。reload 后 TUI 加载失败且 core session_start 成功安装时才由 core 渲染。联合 fixture 必须记录实际 setFooter / cc-footer 的最终归属，覆盖两种加载顺序，不能仅凭 presence=false 判定降级提示已有渲染者。

### 4.4 注释与文档

- 删除或改写三处 "Load order puts cctui before core" 注释，改为"两种顺序都由 core-bus client 处理"。
- `docs/ARCHITECTURE.md` §7 与 `.en.md` 的"通知显示"段落改写为 B3 / B4 规则，并新增 footer 段落。

## 5. 兼容矩阵

| 组合 | 行为 |
| --- | --- |
| 新 cctui + 新 core（有 `instance`） | 按 §4 |
| 新 cctui + 旧 core（无 `instance`） | 用 `onChange` 身份检测 bus 更换；`display.footer` 若在加载期就已发布也能读到 |
| 旧 cctui + 新 core | 维持旧 cctui 行为（core 协商规则未改） |
| cctui 显式 off（无论先前加载顺序） | stock footer；cc-footer 被删除，display.footer 无渲染者，直到后续实际安装扩展 footer；core 加载期 console.warn 仍保留 |
| 新 cctui，无 core | 无快照，所有 adapter 空闲；`readPmStatus` 回落到 legacy / 环境变量（现状） |

## 6. 测试与性能门禁

### 6.1 自动化

| # | 用例 |
| --- | --- |
| C1 | 移植 `reload-sim.mjs`：cctui 先加载 + reload，重载后的通知显示恰好一次 |
| C2 | 移植 `startup-window-sim.mjs`：首启 session_start 通知显示恰好一次 |
| C3 | 移植 `reload-core-first-sim.mjs`：core 先加载 + reload（配合 P0-1 的 shutdown 撤回），post-reload 通知显示恰好一次，fallback 已显示的不重复 |
| C4 | 旧 core 模拟（快照无 `instance`）：bus 更换由函数身份检测 |
| C5 | obs：stop→start/reload 不重复；同 id 不同 toolCallId 分别投递；presence 后 attach 前新批次立即投递，不跳过 |
| C6 | footer：`display.footer` 两行 → cc-footer 输出包含这两行，位置符合 B6；字段缺失时输出不变（golden） |
| C7 | 订阅/退订/单条显示抛错不影响后续；旧 generation 回调零投递；旧 close 不撤回新 presence |
| C8 | native footer 开启时换 bus，通知/obs/footer 仍恢复；没有 cc-status 也不依赖 timer |
| C9 | cap 溢出只处理可见尾部；重复 activate 不推进基线；v1→v2、无 core、坏快照均安全 |
| C10 | 新 session 使用旧 bus 时清空 session 去重；reload 恢复已显示 keys；历史扫描只在事件路径发生 |
| C11 | core-first / TUI-first 启用都由 cc-footer 显示降级行；off 后实际槽位为 stock、无 cc-footer、未隐式重新安装 core；on 后恢复行；reload 中 TUI 加载失败而 core session_start 安装成功则由 core 显示 |

既有的 `pm-capability.test.ts`、`obs-savings.test.ts` 行为断言保留；直接测试模块级私有状态的用例改为通过 client 断言。

### 6.2 性能

`retry()` 在已 attach 且实例未变时，只做固定次数的属性读取与比较（每帧 O(1)），不分配新对象。

### 6.3 真实终端验收

1. 自动化跨仓 fixture 用真实 `createCoreBus` / notify / fallback，控制 core 与 TUI session_start 的调用顺序，分别覆盖首次无 bus、旧快照残留、reload、post-presence publish；不依赖临时目录 sims 仍存在。
2. 真机使用隔离 agentDir / settings fixture（遵循宿主实际参数），在两种扩展顺序下制造一条可重复的配置告警并 reload；不修改用户日常 settings，也不假设 core 的 effort flag 名叫 `--effort`。
3. `/claude-tui off → on` 与 native footer 开关，观察通知、footer、packed 行无意外重复；确认 off 后为 stock 且降级行消失，on 后恢复；TUI reload 加载失败的隔离 fixture 验证 core 实际取得槽位。
4. 同时记录宿主版本/仓库 revision/启动参数/结果。手工未执行时验收保持 open，自动化不冒充真机证据。

## 7. 完成定义

- `npm test` 与 `npm run typecheck` 双绿；§6.3 四步通过并记入 `docs/manual-verification.md`。
- `CHANGELOG.md`：fix（通知丢失、packed 重复）与 feat（显示 core footer 行）。
- `AGENTS.md` 坑 6 补充："加载顺序两种都要成立，订阅统一走 `lib/core-bus.ts`"。

## 8. 代码依据

- 本仓库：`extensions/lib/pm-capability.ts:109-198`、`extensions/lib/obs-savings.ts:32-100`、`extensions/claude-code-tui.ts:409-416, 501-531, 705-715, 833-840`、`extensions/lib/statusline.ts:96-129`
- core：`extensions/bus.ts:116-199`、`extensions/ui/notify.ts:26-68`、`extensions/ui/fallback.ts:37-72`、`lib/pi-compat.ts:81-95`

---

## 9. 实施记录（2026-10-07）

状态：TUI 侧全部实施；自动化绿（251 tests / tsc 0 错）。真机四步（§6.3）保持 open（docs/manual-verification.md §13）。

- **lib/core-bus.ts**：`createCoreBusClient({ store, adapters })` 按 §4.1 落地——activate 同步段采集基线（bus 身份 + 通知 max id + obs keys）→ 写带所有权的 presence 对象 → 订阅 → 立即消费当前快照；retry O(1) 快路径；close 幂等退订/撤回仅自己的 presence/generation 失效。身份检测 B2：`snapshot.instance` 优先（当前 core 09c2dcb 无此字段——已实现的检测路径以 onChange 闭包身份运行，core P1-1 落地后自动切换，**待上游联测**）；v1/无 onChange 不订阅、可重试。
- **三 adapter**：`createNotificationAdapter`（pm-capability.ts，B3 游标：同 bus 从声明 id 续、换 bus 从 0，display 前推进游标）；`createObsAdapter`（obs-savings.ts，B5 全元组 key + 会话域 + `resetSeenFromBranch` 在 session_start 事件路径扫描 branch 重建，onAttach 基线与 branch-scan 并集）；`createFooterChannel`（core-bus.ts，校验/去重/清空语义）。旧的 activateCcTuiChannel/startCoreNotificationConsumer 等模块级单例 API 删除，入口只用 client；teardown 的 obs-stop + presence-withdraw 两步合并为一个 `coreBusClient.close()` 步骤（顺序不变，记录为实施偏差）。
- **footer 渲染（B6）**：`composeFooterLines` 新增 `coreFooter` 槽位（script 行后、hints 前，宽度截断）；cc-footer render 涂 dim 并传行；native footer 模式由 cc-footer render 承担重试点（C8）。无 core 时默认空数组，golden 输出不变。
- **联合 fixture（§6.3.1）**：`test/core-bus.joint.test.ts` 经 jiti（pi 宿主同款加载器，其嵌套依赖内解析）加载**真实** core `bus.ts`/`ui/notify.ts`/`ui/fallback.ts`，C1/C2/C3/C4/C6(footer 半) 全绿；reload 模拟用真实 `resetCoreBusForTests` + 手动保留 stale 快照重建"残留旧快照"条件；core checkout 缺席时整文件 skip。**两仓版本：core `95dcab6`（0.3.0 + spec batch，生产 bus 未改）× TUI 本批提交。**
- C5/C7/C9/C10 以合成 store 覆盖 client/adapter 语义（这些测的是本仓逻辑，非跨仓交接）；C11 经真实 factory（off/on 实际槽位断言 + cc-footer coreFooter 行渲染）；"TUI reload 加载失败后 core 取槽位"的真机路径记录为 open（§13）。
- §4.4 注释与文档：三处加载顺序注释已随模块重写消失/改写（D3 关闭）；ARCHITECTURE 中英 §7 通知段按 B3/B4 重写并新增 footer 段；AGENTS 坑 6（中英）改为"两种顺序都成立，订阅统一走 lib/core-bus.ts"。
