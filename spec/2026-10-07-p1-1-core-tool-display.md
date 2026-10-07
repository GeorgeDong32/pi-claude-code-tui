# core 工具的 CC 行展示：补齐缺口 · 读结构化 details · 通用摘要 · MCP 形状对齐

日期：2026-10-07

状态：三步已实施（7319c74）；真实工具行验收 open，见 [后续验收规格](2026-10-08-followup-validation.md)。

范围：本仓库 `extensions/lib/cc-rows.ts`、`extensions/lib/takeover-rules.ts`、入口 resolver（`extensions/claude-code-tui.ts:284-345`）

来源：2026-10-07 联合架构审查，清单项 TUI-07（报告 X2 卡片）。core 侧在 `spec/2026-10-07-p1-1-bus-surface-for-cctui.md` 中登记 XPKG-04 / 05 / 06。

## 1. 基线与事实

1. **工具名表与 core 漂移。**
   - `builtinCallArgs`（`cc-rows.ts:51-103`）硬编码了 12 个 core 工具的摘要规则；core 已注册、但不在表里的有 3 个：
     - `abort_goal { reason }`
     - `apply_goal_tweak { newObjective, changeSummary }`
     - `goal_question { question, context?, options?, … }`
   - 不在表里的工具会落到 JSON 回退（`cc-rows.ts:203` 附近）。
   - 本机 prefs 是 `toolRows: true`，即 force 模式：core 工具自带的 renderCall 会被 CC 行替换，所以这 3 个工具的调用行现在显示整段 JSON（`apply_goal_tweak` 会把完整的新目标文本铺在行上）。
2. **obs_recall 解析的是文本协议。**
   - `cc-rows.ts:126-127` 用正则解析结果文本的两行 header。
   - 而 core 在 `details` 里已经给出结构化字段 `{ id, offset, bytes, lines, nextOffset, eof }`（core `observation-pack/index.ts:127-130`）。
   - core 一旦调整 header 文本，这里只会静默退化，任何测试都不会变红。
3. **MCP 名识别是第二份形状判定。**
   - `cc-rows.ts:359-365` 只识别 `mcp__server__tool` 与 `mcp_server_tool` 两种形态。
   - core 的权威（`lib/mcp-shape.ts`）还认 proxy 形态（工具名 `mcp`，真实名在 `input.tool`）与 direct-named 形态（`PI_CORE_MCP_DIRECT_SERVERS` 列出的 server，如 `exa_search`）。
   - 后果：这两类调用没有 `(MCP)` 徽标，接管决策也不按 MCP 处理（`takeover-rules.ts` 的 `isMcp`）。
4. **`then_run` 参数形状**（`claude-code-tui.ts:316` 读取 `args.then_run.command`）此前没有跨包登记。

## 2. 目标与约束

### 2.1 必须实现

- 已列出的 core 工具在 force 模式下提供一行摘要；未知工具优先 schema，无法摘要时保留有界 JSON 回退。
- obs_recall 显示优先使用 `details`。
- 新增工具若暴露可识别的顶层 string 参数，本包无需新增工具名分支；无法识别的 schema 不保证自动得到最佳摘要。

### 2.2 显示层红线

只改 renderCall / renderResult 的输出，不改参数与 `execute`。

### 2.3 不做的工作

- 不改 takeover 矩阵的用户开关语义。
- 不改 `FORCE_RESULT_EXEMPT`。

## 3. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 |
| --- | --- | --- | --- | --- | --- |
| R1 | 补缺口 | A 只补 3 个名字；B **补 3 个名字 + 第二步的通用摘要兜底** | **B** | — | 无 |
| R2 | 通用摘要的依据 | A 按参数名启发式；B **按工具参数 schema**：session_start 时从 `pi.getAllTools()` 缓存 name→parameters，取第一个"优先字段名"中出现的 string 参数，否则取第一个 required string；C 由 core 在 bus 上发布摘要提示 | **B** | C 的精确度（bus 是纯数据，且会增加跨包面） | schema 缺失时回落 JSON，与现状一致 |
| R3 | obs_recall | A 继续解析文本；B **先读 details，缺失再解析文本** | **B** | — | 无 |
| R4 | MCP 形状 | A 维持两种；B **对齐 core 的五类判定分支**（proxy 按 `args.tool` 解析；direct-named 读同一个环境变量 `PI_CORE_MCP_DIRECT_SERVERS`）；C 由 core 经契约发布 shape 规则 | **B** | C 的单一来源 | B 仍是独立显示镜像，可能影响 auto 接管选择；用两仓共享样例对拍，不影响权限裁决；在 header 注释中写明"复刻自 core `lib/mcp-shape.ts`" |
| R5 | resolver 无 args 时如何判定 proxy | A 把所有名为 mcp 的工具强认领；B **只用足以确定的名字，proxy 继续走原工具的 auto/force 矩阵，renderCall 有 args 后才格式化徽标** | **B** | 不为通用代理名改变 auto 所有权；direct-named 有显式 server 配置时可以识别 | 少量 proxy 在 auto 下继续让给原 renderer，避免抢走自带 UI |

## 4. 设计

### 4.1 第一步（立即）

`builtinCallArgs` 新增：

- `abort_goal: (a) => shortText(a.reason, 40)`
- `apply_goal_tweak: (a) => shortText(a.changeSummary ?? a.newObjective, 60)`
- `goal_question: (a) => shortText(a.question, 60)`

obs_recall 的结果整形（`obsRecallDisplayView`）先校验 `result.details`：id 为非空字符串，offset/bytes/lines/nextOffset 为 finite 非负数字，eof 为 boolean；完整时用于生成 human header，否则走原正则。只删除明确匹配已知协议的两行，不因 details 完整就盲删正文前两行；文本无 header 时保留正文；局部 details/错误结果不伪造成功分页。原 result/content/details 不可原地修改，其他 content block 不丢弃。

### 4.2 第二步（中期）：schema 驱动的通用摘要

- 新增 `lib/tool-summary.ts`：`summarizeArgs(args, schema?) → string`。
- 优先字段名顺序：`objective, query, question, reason, changeSummary, path, file, url, command, topic, title, summary, name`。
- `builtinCallArgs` 中 core 段的 12 个条目只保留"通用规则给不出好结果"的几个：`obs_recall` 的 id+offset 格式、`memory_consolidate` 的 ops 计数、`session_recall` 的 since 段。其余删除。
- schema 缓存：enable/session_start 及成功 tool_search 的既有事件点从 `pi.getAllTools()` 更新；宿主 `ToolInfo.parameters` 已在本地 1.0.1 声明中确认。resolver/render 只读缓存，不全量扫工具。不能在 disable/headless 路径发起额外读取。
- 优先字段必须在 schema 顶层声明且运行时确为非空 string，之后按 required 数组顺序找 string；union/$ref/递归 schema 本批不展开。摘要统一压空白/换行、按现有 clamp 截断；空参给空摘要，无可用字段时用有界 JSON。故障不得抛出 render。
- 特殊规则的删除先用现有 12 个工具样例对照 golden；goal_questionnaire 的数组参数、get_goal 空参等不能因“通用”目标退化为整段 JSON。保留必要特例并列明原因。

### 4.3 第三步（中期）：MCP 形状

- `mcpDisplayName(toolName, args?)`：
  - 新增 proxy 分支——`toolName === "mcp"` 且 `args.tool` 是字符串时，按其解析；
  - 新增 direct-named 分支——server 名出现在 `PI_CORE_MCP_DIRECT_SERVERS`（与 core 同一个环境变量，同样的解析规则）。
- native 双/单下划线、bare mcp_*、proxy、direct 五类对照 core `canonicalizeMcpShape`；包括混合下划线、未知 server、缺失/坏 args、bare mcp（无合法目标）负例。逗号分隔的配置 trim + lowercase Set 与 core 一致。
- resolver 拿不到 args 时不把裸 `mcp` 判为 MCP；在 callFactory 用 `mcpDisplayName(toolName, args)`，结果标题只有宿主可靠传入参数时才使用 proxy 目标，否则回退工具名，不用模块级“最近一次 args”串扰并行行。
- 不 import sibling repo 的私有 lib，也不在 core 内新增第二套权威；TUI 显示镜像用源自 core 的固定 fixture 同步验证。

## 5. 测试

| # | 用例 | 位置 |
| --- | --- | --- |
| R-T1 | 3 个新 summary 的 golden 行 | `test/cc-rows.golden.test.ts` |
| R-T2 | obs_recall：只有 details（文本无 header）时生成 human header；只有文本时走正则；两者都有时以 details 为准 | `test/obs-recall-view.test.ts` |
| R-T3 | 通用摘要：schema 含 `objective` / 只含未知 required string / 无 schema 三种情况 | 新文件 `test/tool-summary.test.ts` |
| R-T4 | MCP：proxy `{tool:"mcp_exa_search"}` → `exa - search (MCP)`；在环境变量列表中的 direct-named → 识别；不在列表中的 → 不识别 | `test/cc-rows.golden.test.ts` |
| R-T5 | 接管矩阵：配置内 direct-named 按 MCP；裸 mcp 依原 auto/force 矩阵，不抢有 renderer 的代理；force 正常加徽标 | `test/takeover-rules.test.ts` |

golden 改动须在提交信息中说明视觉差异（AGENTS 代码约定）。

R-T2 另覆盖坏数字/局部 details、文本与 details 冲突、非文本 content block，以及输入对象 deepFreeze 后可渲染。R-T3 覆盖工具发现后刷新、未知 schema、长文本/换行；三步分别 golden 审阅，不强制无关视觉变化。

## 6. 完成定义

- `npm test` 与 `npm run typecheck` 双绿。
- `docs/manual-verification.md` 新增：force 模式下 3 个 goal 工具行、proxy MCP 行。
- `CHANGELOG.md`：R1 / R3 为 fix，R4 / R5 为可见变化。

## 7. 代码依据

- 本仓库：`extensions/lib/cc-rows.ts:51-139, 350-374`、`extensions/lib/takeover-rules.ts`、`extensions/claude-code-tui.ts:284-345`
- core：`extensions/goal/goal.ts:1905-1935, 2006-2040`、`extensions/goal/goal-questionnaire.ts:500-530`、`extensions/observation-pack/index.ts:119-130`、`lib/mcp-shape.ts`

---

## 8. 实施记录（2026-10-07）

状态：三步全部实施，自动化绿（237 tests / tsc 0 错）；真机项 open（docs/manual-verification.md §12）。

- 第一步（R1）：三个 goal 工具由通用规则覆盖（见下），`builtinCallArgs` 不再按名分支——按 R2 决策并入第二步落地，效果与 §4.1 一致（`abort_goal`→reason、`apply_goal_tweak`→changeSummary、`goal_question`→question，均 60 字 clamp）。
- 第二步（R2）：`lib/tool-summary.ts` 落地（preferred 13 字段 + required string 顺序，空参空摘要，union/$ref 不展开）；入口在 enable / session_start 刷新 schema 缓存；**偏差**：pi 1.0.1 无 `tool_search` 事件，改用宿主既有 `mcp_servers_change` 作为工具集变化刷新点（规格允许的"既有事件点"适配）。表条目按 §4.2 只留 obs_recall / memory_consolidate / session_recall，删除 9 个（含 `pi_review_report`/`step_complete` 的过时字段——旧表锚的字段已不在 core schema 中，通用规则给出 runId/evidence 更准确）。golden 对照以 core 真实 Type.Object 形状的 fixture 完成。
- 第三步（R4/R5）：`mcpDisplayName(toolName, args?)` 五形状镜像（bare 无分隔不认领为显示名）；resolver 无 args 时裸 `mcp` 不判 MCP、走原 auto/force 矩阵；callFactory 用 args 解析 proxy 徽标；resultFactory 无 args 回退工具名，不用模块级 args 串扰。**两仓对拍**：`test/cc-rows.golden.test.ts` 直接 import 真实 `../../pi-claude-code-core/lib/mcp-shape.ts`（零依赖纯模块）跑共享样例（native1/2、bare、proxy、direct、混合下划线、未知 server、坏 args），core 无 checkout 时 t.skip；bare 无 server/tool 对的分歧在断言中显式声明。
- obs_recall（R3）：`obsRecallDisplayView` 先校验 details（id 非空串 + 四个 finite 非负数 + boolean eof），完整则生成 human header（与文本路径同一 `humanRecallHeader` 单一家）；正文只删 regex 命中的协议行；入口重建 display 对象时保留非 text content block，原对象不改。R-T2 覆盖坏数字/局部/错误 details、冲突、deepFreeze。
