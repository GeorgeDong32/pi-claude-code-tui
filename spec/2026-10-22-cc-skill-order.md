# CC 式 skill 调用顺序与用户条恢复（spec 2026-10-22）

日期：2026-10-22
状态：R1 对抗评审已过（无 P0/P1；P2×3、P3×3 全部采纳，见 §6）；R2 实现验收 **accept**（A–F 全 PASS；P3 报告项 3 条亦已采纳，见 §7）
性质：纯显示层改动（红线：不改工具 execute、不改发给模型的内容）

## 1. 问题（用户报告 + 源码实锤）

用户提交 `/skill:diagnosing-bugs 测试` 时，pi 渲染为：

```text
⏺ Skill(diagnosing-bugs) (ctrl+o to expand)

❯ 测试
  ⎿  Interrupted · What should Pi do instead?
```

两个缺陷（对照 CC）：

1. **顺序反了**：skill 行在用户条**之前**。CC 是用户条在前、`⏺ Skill(name)` 行在后。
2. **用户输入残缺**：pi 展开后用户条只剩 args（`测试`），用户敲的 `/skill:diagnosing-bugs` 前缀消失。CC 的用户条保留完整原文 `❯ /skill:diagnosing-bugs 测试`。

CC 目标形态：

```text
❯ /skill:diagnosing-bugs 测试

⏺ Skill(diagnosing-bugs) (ctrl+o to expand)
```

### pi 侧证据（pi 1.4.0，本仓 node_modules；R1 逐条复核过）

- `core/agent-session.js` `_expandSkillCommand`（~L1726–1741）：仅**行首** `/skill:name args` 展开为
  `<skill name="…" location="…">\n…\n</skill>\n\n{args}`（args `.trim()`；一条消息只展开开头的 `/skill:`，多个 skill 不展开——pi 核心语义）。
- `modes/interactive/interactive-mode.js` `addMessageToChat` "user" 分支（L3148–3180）：
  `parseSkillBlock` 命中后**先** append `SkillInvocationMessageComponent`，有 args 时再 `Spacer(1)` + `UserMessageComponent(skillBlock.userMessage)`（仅 args 文本）；**无 args 时连用户条都不渲染**（typed 命令零痕迹）。
- 调用点全量（R1 grep 核实）：user 分支只从 L2792（`message_start` 增量）与 L3265（`renderSessionItems`，覆盖初始加载 / 压缩重建 / 分支渲染）到达——**同一咽喉点**；`new UserMessageComponent` 全文件仅 L3163/L3168 两处。
- 既有 quirk（记录、不修）：`renderInitialMessages` 以 `populateHistory: true` 把**展开后**的整段 skill block 塞进编辑器历史（↑ 召回展开文本而非 `/skill:name args`）。
- `UserMessageComponent`：`text` 逐字存储 + `rebuild()`；`render()` 给首/末行包 OSC133 A/B/C 标记。`Container.children` 是普通数组，pi 自己也 splice 它。

## 2. 方案

新增 `extensions/lib/cc-skill-order.ts`：`PrototypeMethodAdapter` wrapper patch
`InteractiveMode.prototype.addMessageToChat`（与 cc-notices 的 showError/showWarning tap 同款工厂形态，入口传 proto + DEC-N11 形状门控）。

**hostMatches 门控**（对齐 userBarAdapter 先例）：

```ts
(host) => Array.isArray((host as { chatContainer?: { children?: unknown[] } }).chatContainer?.children)
```

body 流程（wrapper 式，原始调用在前；**DEC-N4 豁免形态**，见下）：

1. 记 `before = chatContainer.children.length`（此时 original 未跑，任何失败 → adapter 降级重放恰好一次，安全）。
2. 调 `original.apply(host, args)`，**自带 try/catch 吞掉**（不回滚：保留原生部分行；吞掉即保证重放不可达）。
3. 调 `reorderAppendedSkillBlock(children, before, makeBubble)`，**内部全 swallow**（失败 = 原生顺序，安全降级）。original 之后 body 不存在任何可外抛语句。

**DEC-N4 豁免不变量**（写进模块头与 `pi-proto-adapter.ts` 契约注释，R1-P2#1）：本 body 必须在 original 之后工作（重排 original 的产物）；它以「original 自身失败也吞掉 + original 之后所有步骤整体 swallow」维持与 DEC-N4 同一条不变量——original 成功执行后 body 永不外抛，adapter 外层 catch 只可能在 original 未跑时触发，降级重放永远不会在成功 append 之后发生（R1-P2#2：不做回滚，回滚自身抛出反而会触发双 append）。

`reorderAppendedSkillBlock` 只看**本次 append 的切片** `[before, after)`（杜绝把前一条消息的尾部误认成本次；空文本用户消息 append 0 个元素时切片为空、天然跳过）：

- **with-args**：切片形如 `[lead?, skill, spacer, user]`（lead 为可选前置 Spacer）。
  识别：`slice[len-1]` user-like（`text: string` + `rebuild(): void` 鸭子）、`slice[len-3]` skill-like（`skillBlock.name: string` + `setExpanded` 鸭子）、且 `user.text === skillBlock.userMessage`（非空）。
  动作：切片重排为 `[lead?, user, spacer, skill]`，`user.text = "/skill:" + name + " " + user.text` 后 `rebuild()`（rebuild 失败则回写原 text，不外抛）。
  恒等校验即幂等防双前缀（二次进入时 text 已带前缀、不再等于 userMessage）。
- **no-args**：切片形如 `[lead?, skill]`，`skillBlock.userMessage` 为空/缺省，且 skill 组件无 `__ccSkillOrderApplied` 实例标记（防任何病态重入二次注入）。
  动作：注入 `makeBubble("/skill:" + name)`（真 `UserMessageComponent`：markdownTheme 取 `host.getMarkdownThemeWithSettings?.()`，outputPad 取 `host.outputPad ?? 1`，transformers 取 `host.getMarkdownTransformers?.() ?? []`，构造失败返回 null 即放弃注入），重排为 `[lead?, bubble, Spacer(1), skill]`。
  两分支都在 skill 组件实例上打 `__ccSkillOrderApplied` 标记。
- 其余形状原样返回（不动）。

要点：

- **显示层语义**：transcript entry 仍是展开后的 skill block 文本；模型侧不变。用户条显示的是**归一化重建**的输入（pi 侧 args 双侧 `.trim()`，双空格/尾空白会归一为单空格——R1-P3#4，接受）。
- skill 行外观仍归 `cc-skill-row.ts`（`⏺ Skill(name)` 行本体）；本模块只管**顺序**与**用户条文本/存在性**。用户条样式自动走既有 `userBarAdapter`（padding 归零），重建/注入都会流经它。
- ctrl+o 全局展开是**平铺**遍历 `chatContainer.children`（`setToolsExpanded` 只走一层），重排后 skill 行仍是顶层 child、可达性不变；用户条无 `setExpanded`、天然不可见（R1 核过）。
- 注入气泡会给 no-args 场景引入一对原 transcript 没有的 OSC133 prompt-zone 标记（与既有用户条同类输出，接受；人工验证清单注记——R1-P3#5）。
- 生命周期：挂进入口 `patches.applyAll / restoreAll`（与 `patchSkillRow` 同生命周期，无独立 pref/env 开关——与 skill 行外观一致）。

## 3. 测试（`test/cc-skill-order.test.ts`，golden/table 风格，真组件参照 `cc-skill-row.test.ts`）

纯函数表测 + 真组件联测（`initTheme`）：

1. with-args 切片（len 3 / len 4）→ 顺序换为 user/spacer/skill、text 带前缀、rebuild 恰好一次。
2. no-args 切片（len 1 / len 2）→ 注入 bubble（工厂 stub 验证文本 `/skill:name`）+ 真 Spacer，skill 仍在最后；重排后 skill 行仍是顶层 child、平铺 ctrl+o 遍历可达（模拟遍历一行钉住——R1-P2#3d）。
3. 负样本：普通用户条切片、assistant 切片、`user.text !== skillBlock.userMessage`、带 `__ccSkillOrderApplied` 标记的 no-args skill → 原样不动。
4. makeBubble 抛出 / 返回 null → 切片原样、不外抛。
5. 同一切片二次处理 → 不双前缀（恒等校验）。
6. adapter 降级：host 无 `chatContainer.children` → hostMatches 失败，original 恰好一次、无重排。
7. original 抛出 → 吞掉不外抛、不重放（original 恰好一次）、原生部分行保留（R1-P2#2 选吞不回滚）。
8. args/options（含 `populateHistory: true`）原样穿透 wrapper 到 original（R1-P2#3a）。
9. len 0 切片（空 textContent，append 0 元素）→ 不动（R1-P2#3c）。
10. 「original 成功后 body 不外抛」adapter 级断言：host 的 `getMarkdownThemeWithSettings` 抛出 → makeBubble 返回 null、原生顺序、original 恰好一次（R1-P2#3b）。
11. 真 `UserMessageComponent` 前缀重建 + render 一行（markdown 路径不炸、含前缀文本）。

## 4. 文档（R1-P2#1 增补两处契约文本）

- `extensions/lib/pi-proto-adapter.ts` 模块头：DEC-N4 豁免条款（成立条件：original 自吞 + 后置全 swallow）。
- `AGENTS.md` / `AGENTS.en.md`：踩坑 4 的现存 patch 清单补 `addMessageToChat` skill 顺序 wrapper；踩坑 12 补豁免注记；模块地图补 `cc-skill-order.ts`。
- `docs/ARCHITECTURE.md`（及 .en）：patch 清单行与模块表补 `cc-skill-order.ts`。
- `docs/manual-verification.md`：skill 顺序人工项（气泡在前、无 args 也出气泡、ctrl+o/点击展开不受影响、resume 后一致）+ OSC133 注记。
- `CHANGELOG.md` Unreleased。

## 5. 非目标（明确不做）

- **一条消息多个 skill**：pi 三层语义（`_expandSkillCommand` 只展开行首、`parseSkillBlock` 单块正则、渲染分支单块）都在 pi 核心；此前已拍板 CC-TUI 不碰（分条消息即可）。要改去改 pi。
- 编辑器历史的展开文本 quirk（populateHistory）：pi 侧行为，仅记录。
- 不动 skill 行本体渲染（`cc-skill-row.ts` 已有）、不动 transcript/模型上下文。

## 6. R1 评审采纳记录（reviewer：glm-5.3-flash，2026-10-22）

- P2#1 DEC-N4 豁免写入契约文本（pi-proto-adapter 头注释 + AGENTS 踩坑 12）→ §2/§4 已并入。
- P2#2 回滚行自身可抛 → 选方案 (a)：不回滚、只吞；原生部分行保留 → §2 已改。
- P2#3 测试补 4 条（options 穿透 / 不外抛 adapter 级 / len0 / ctrl+o 平铺可达）→ §3 #8–#10、#2 已并入。
- P3#4 「原文」改「归一化重建」→ §2 已改。
- P3#5 OSC133 新区标记注记 → §2/§4 已并入。
- P3#6 hostMatches 门控表达式写明 → §2 已补。

## 7. R2 验收记录（reviewer：glm-5.3-flash，2026-10-22）

- A–F 全 PASS（spec 决策逐条落实、DEC-N4 豁免不变量成立、幂等与生命周期无冲突、测试 16 项覆盖 spec §3 全部 11 条、文档双语同步逐锚点命中）；总裁定 **accept**。
- P3 报告项 3 条也已采纳：`replica-session.ts` SessionPatches 注释补 skill-order；真 `InteractiveMode.prototype` 端到端冒烟测试（N-T5b 先例：apply→真 addMessageToChat 走 CC 顺序→restore 引用相等）；AGENTS 模块地图措辞对齐「归一化重建」。
- 测试/typecheck 由 supervisor 实跑：374→376 passed（新增真原型端到端 1 项后以实际数目为准）、tsc 0 错。
