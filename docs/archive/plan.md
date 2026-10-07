# pi 1.0.x 升级适配方案（已归档）

> **归档横幅（2026-10-07）**：本方案已过时并归档——其中的决策（peer `>=0.85.0`、发版 1.7.1）已被 `package.json` 的 `>=1.0.1` 与 1.8.0+ 发版取代。现行权威：`spec/`（实施规格）、[docs/ARCHITECTURE.md](../ARCHITECTURE.md)、[CHANGELOG.md](../../CHANGELOG.md)。此处仅保留历史决策可追溯性（P3-1 D4）。

# pi 1.0.x 升级适配方案

> **状态更新（2026-10-03）**：本方案的路线已调整为「先迁移 registerToolRenderer 通道」——spec 与四轮对抗评审已完成且实现已验收 ACCEPT（见 `~/Coding/Pi-Extension/specs/design/2026-10-03-pi-1.0-tool-renderer-migration-spec.md` 与同目录四份 REVIEW）。Phase 1（依赖升级+自动验证）与 Phase 3（文档同步）已随迁移完成；Phase 4 发版号改为 1.8.0（feat）。剩余：Phase 0（用户升全局 pi 到 1.0.1）→ Phase 2 视觉回归（追加 spec §8.6 迁移专项清单）→ Phase 4 提交/发版。
> 前期审计已完成（2026-10-03，对照 `@earendil-works/pi-coding-agent@1.0.1` 实际 dist 逐面核对）。基线：`npm test` 101 绿 · `npm run typecheck` 干净 · 本机 pi 0.99.1。

## 审计结论总览

**核心结论：pi 0.99.1 → 1.0.x 对本包是 API 全兼容升级，零强制代码适配。** 工作量集中在依赖 bump、回归验证和文档同步。

### 逐面核对表（证据）

| 本包依赖面 | 1.0.1 状态 | 证据 |
| --- | --- | --- |
| 顶层导入：`ToolExecutionComponent` / `UserMessageComponent` / `createXxxToolDefinition`×7 / `keyText` / `renderDiff` / `CompactionSummaryMessageComponent` / `SkillInvocationMessageComponent` / `initTheme` / `Theme` / `VERSION` / `CustomEditor` | 全部健在 | `dist/index.d.ts` 逐一 grep 确认，`createXxx` 导出清单与 0.99.1 逐字节一致 |
| pi-tui 导入：`CURSOR_MARKER` / `EditorTheme` / `truncateToWidth` / `visibleWidth` / `wrapTextWithAnsi` | 全部健在 | pi-tui@1.0.1 `dist/index.d.ts` |
| `ToolExecutionComponent` 渲染钩子（`getCallRenderer`/`getResultRenderer`/`getRenderShell`）— prototype patch 命脉 | **逐字节一致** | 两版 `tool-execution.js` diff，仅图片转换内部重写，渲染路径零改动 |
| 渲染器解析链 | 兼容且加强 | 0.99.1 `withBuiltInRenderers(toolName, session.getToolDefinition())` → 1.0.1 外包一层 `resolveToolRenderers(toolName, next)` 扩展链；`definition.renderCall ?? builtIn.renderCall` 语义不变，我们 `pi.registerTool` 的定义仍优先 |
| 9 个事件（session_before_compact/compact/compact_failed/start、message_end、model_select、agent_start/settled、session_shutdown） | 全部健在 | `core/extensions/types.d.ts` |
| ctx.ui 方法（setEditorComponent/setWidget+belowEditor/setFooter/setHeader/setHiddenThinkingLabel/setWorkingVisible/setWorkingIndicator/setWorkingMessage/notify） | 全部健在 | 同上 |
| 压缩组件（`CompactionSummaryMessageComponent` / `CompactionStatusIndicator`） | **零 diff** | 两版文件 diff 为空 |
| skill 行、custom-editor、extension-editor、keybinding-hints、diff.js、theme.js | **零 diff** | 逐文件 diff 为空 |
| pi-tui text/box/container/editor | **零 diff** | 逐文件 diff 为空 |
| `getThinkingLevel` / `getAllTools().sourceInfo` / statusline 脚本协议 | 全部健在 | types.d.ts + 文档 diff |
| pm-capability（globalThis 与 core 的握手） | 不受影响 | 与 pi 版本无关，是 cctui ↔ core 的私有协议 |

### 三个行为性变化（不改代码，需视觉验证）

1. **`UserMessageComponent` 内部重构**（1.0.0 修复"user message 双份全宽行"bug）：Box 包装移除，Markdown 自绘背景（`bgColor` 选项）。我们的 `rebuild` patch（children paddingY 归零）仍能命中 Markdown 子组件（paddingY=1→0），但叠加去重修复后用户消息条的最终视觉**可能有差**——Phase 2 重点项。
2. **`tuiMode` 默认值 regular → fullscreen**：本机已显式 fullscreen，不受影响；但需在 regular 模式下过一遍（其他用户会走默认）。
3. **system theme 色度修复**（pastel palette 保持 chroma）：只影响终端 16 色调色板推导的 system 主题；本包 `claude-code.json` 全显式 hex，理论无差，肉眼确认即可。

### 一个新能力（本次不采用）

**`pi.registerToolRenderer((toolName, next) => renderers)`**（1.0.1 新增）：官方渲染器解析通道，可为任意工具（含未注册的 MCP 工具）供渲染器。潜在收益：替代 `patchThirdPartyToolRows` prototype patch（消除 jiti 多实例风险面）+ `registerToolOverrides` 的 7 内置 execute 委托（更纯粹满足显示层红线）。但现有路线在 1.0.1 零 diff、无压力，迁移属独立重构，**单独立项**，不混入本次升级验证变更集。

## 决策点（推荐路线，如无异议按此执行）

1. **目标版本：1.0.1**（非字面 1.0.0）——1.0.0 两天后的 bugfix 版，含 registerToolRenderer 与 `/reload` defaultTools 修复；停在 1.0.0 无理由。
2. **本次范围：纯适配**（依赖 bump + 验证 + 文档 + patch 发版）；registerToolRenderer 迁移另立后续任务。
3. **peerDependency：保持 `>=0.85.0`**——零代码适配、未用新 API，范围声明保持诚实。
4. **发版号：1.7.1**——无用户可见功能变化，patch 合适。

## Phase 0 · 前置（用户操作）

- 全局 pi 升级到 1.0.1（`pnpm i -g @earendil-works/pi-coding-agent@1.0.1` 或等价方式），`pi --version` 确认。

## Phase 1 · 依赖升级 + 自动验证

1. `package.json` devDependencies：`@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` `0.99.1` → `1.0.1`（`@types/node`、`typescript` 不动）。
2. `npm install`（package-lock.json 在 .gitignore，不入库）。
3. `npm test` + `npm run typecheck` 在 1.0.1 下双绿。
   - golden 测试若红 = 真实行为变化，**停止并逐字节分析**（预期不红：渲染路径零 diff，golden 钉的是我们的纯渲染器输出）。
4. 跑 `node scripts/bench-statusline.mjs` 确认 statusline 性能无回归。

## Phase 2 · 视觉回归（对照 docs/manual-verification.md，在 pi 1.0.1 下）

按风险排序：

1. **用户消息条**（最高风险）：CC 式灰条 + ❯ + paddingY patch，对照 1.0.0 的 UserMessageComponent 重构；若有视觉差，属真实代码适配点，当场修（改动预期收敛在 `cc-markdown.ts` 的 `userMessageBar` 或主入口的 rebuild patch，golden/table 测试同步更新）。
2. 工具行全家福：7 内置（call/result/diff/折叠）、第三方/MCP 行（`server - tool (MCP)` dim 后缀）、force 模式、obs_recall 豁免行。
3. 压缩行 + skill 行（组件零 diff，快速过）。
4. 启动头（自绘，理论不受 BuiltInHeader 变化影响）、编辑器（custom-editor 零 diff）。
5. statusline/footer/spinner 动词 + shimmer/完成行/权限模式徽标。
6. **regular 模式过一遍**（tuiMode 默认已变 fullscreen，防止其他用户路径回归）。
7. 主题整体观感（chroma 修复理论无差，肉眼确认）。

## Phase 3 · 文档同步（per docs-sync-on-process-decisions）

1. `README.md` L27 兼容性表述：dev/test target 0.99.1 → 1.0.1。
2. `AGENTS.md` L62、L66：`0.99.x` → `1.0.x`，scope 示例补 `1.0-adapt`。
3. `AGENTS.en.md` 对应两行同步。
4. `docs/ARCHITECTURE.md`：grep 确认无版本引用需改（预计无）。
5. `CHANGELOG.md`：1.7.1 条目（pi 1.0.x 适配验证，devDeps 升级，无行为变化）。

## Phase 4 · 发版（git-first 流程）

1. `package.json` version → 1.7.1。
2. `chore(release): 1.7.1`（适配过程如有代码修，另以 `fix(tui): …` scope `1.0-adapt` 单独提交）→ `git tag v1.7.1` → push。
3. 安装目录 `git pull` + pi 内 `/reload` 生效；npm publish 可选、由用户本人凭据决定（不阻塞）。

## 风险表

| 风险 | 缓解 |
| --- | --- |
| UserMessageComponent 重构致用户条视觉差 | Phase 2 第 1 项重点验证；差则当场修 + golden/table 同步 |
| golden 测试变红 | 红即停，逐字节 diff 定位真实行为变化，不在红的状态下发版 |
| 升级后才发现未审计到的内部耦合 | 本包所有内部耦合点（prototype patch / 实例 render 覆盖 / 组件树搜索）均已逐文件 diff 确认零改动；残余风险集中在 Phase 2 兜底 |
| pi-subagents / pi-claude-code-core 的 1.0 适配 | 不属本仓范围；pm 通道为两包私有协议不受 pi 版本影响，core 侧适配由用户另行安排 |

## 后续任务（不在本次范围，记录在案）

- **registerToolRenderer 迁移评估**：官方渲染通道替代 prototype patch + registerTool 覆盖两套 hack；需 takeover-rules 增加 built-in 判定路径（现 `builtInToolDefinition` 探针在两版 dist 中均不存在，恒 undefined）+ 表测更新 + peerDep 语义决策（是否借机升 `>=1.0.1`）。独立立项，验收标准：渲染输出与现路线字节级一致。
