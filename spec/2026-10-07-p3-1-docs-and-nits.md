# 文档漂移与小问题批

日期：2026-10-07

状态：规格已补齐，待实施；各项独立，可分开提交

范围：本仓库文档与若干小处代码

来源：2026-10-07 联合架构审查，清单项 TUI-09 / TUI-13 / TUI-15

## 1. 条目

| # | 条目 | 证据 | 处置 |
| --- | --- | --- | --- |
| D1 | `AGENTS.md` 的目录结构缺少 3 个 lib 模块 | `AGENTS.md`「目录结构」；实际存在的 `subagent-presentation.ts`、`cc-subagent-rows.ts`、`pi-proto-adapter.ts`（ARCHITECTURE §2 已列出） | 补齐；`AGENTS.en.md` 同步 |
| D2 | ARCHITECTURE §3 说 user-bar 补丁在**加载期**打 | `docs/ARCHITECTURE.md:61`；实际在 `enable()` 中调用 `applyUserBarPatch()`（`claude-code-tui.ts:749`） | 改到 `session_start → enable` 段；`.en.md` 同步 |
| D3 | 加载顺序注释与实际配置相反 | `pm-capability.ts:139-140`、`obs-savings.ts:12`、`claude-code-tui.ts:836`；本机 settings 为 core 先、cctui 后 | 由 P0-2 一并改写；若 P0-2 推迟，先单独改注释 |
| D4 | `plan.md` 已过时 | 其中的决策（peer `>=0.85.0`、发版 1.7.1）与 `package.json` 的 `>=1.0.1`、1.9.0 矛盾 | 移到 `docs/archive/`（或 `spec/notes/`），文件头加归档横幅 |
| D5 | `cc-status` 的 `setTimeout(0)` 重注册依赖隐式顺序 | `claude-code-tui.ts:577-589`；注释的前提是"core 的 goal widget 晚于 cctui 注册"，在本机 core 先加载的同步启动路径下该重排可能多余，但迟到回调存在 stale ctx 风险（归 P0-1） | 保留尽力重注册；注释说明 macrotask 不保证晚于所有异步 handler 或后续 widget 更新。core P1-1 登记 XPKG-09-HOST；未取得真实顺序证据保留 todo。timer 清理/generation 修复归 P0-1 |
| D6 | 原生 footer 模式下，压缩指示器静音的重试白跑 | `claude-code-tui.ts:816-822`：`showNativeFooter` 时 `cc-status` 已卸载，`dockTui` 失效 | `showNativeFooter` 时跳过 `hush` |
| D7 | statusline stdin 写入使用 `lastInput` | `statusline.ts:331`；应使用本次运行的 `activeInput`（目前两者等价，但以后引入 await 就会出错） | 改为 `activeInput` |
| D8 | ANSI 小工具重复 | `padRight`（`claude-tui-editor.ts:34`、`pi-startup-header.ts:395`）、`stripAnsi` / `stripAnsiTail`（editor:15 / `cc-subagent-rows.ts:373`，后者不处理 APC 序列）、`RESET` 出现 4 次 | **仅在顺手修改时合并**到 `format.ts`；`stripAnsiTail` 若会处理带 APC 的输入，就改用完整版本 |

## 2. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 |
| --- | --- | --- | --- | --- |
| P1 | `plan.md` 去向 | A 删除；B **归档** | **B** | 放弃删除后的目录简洁；保留历史决策可追溯性 |
| P2 | D8 是否单独立项 | A 立项；B **随手合并** | **B** | 一个 shallow 的 `ansi.ts` module 不值得单独成项（deletion test 不成立） |

## 3. 测试与完成定义

- D6：`test/run-state.test.ts` 或入口测试补一条"native footer 模式下不调度 hush"（若 P2-1 已落地，放进 `replica-session.test.ts`）。
- D7：`test/statusline.test.ts` 断言 stdin 收到的是本次运行的输入。
- D8 若实施：`stripAnsiTail` 只处理尾部控制码，不能直接换成去掉全文 ANSI 的函数；先 pin 颜色/RESET/APC/宽字符行为，golden 无意外变化。不以名字相似为理由统一不同语义。
- D4 移动归档后修所有指向旧 plan.md 的链接，归档 header 说明以现行 spec/架构文档为准。
- D5：两种加载顺序 + 后一个 session_start 跨 macrotask await + turn 后 widget 更新均记录真实宿主行为，不把当前 workaround 写成硬保证。排序承诺要等正式宿主 interface 或独立实现方案。
- D1/D2/D3/D4 为文档，D6/D7 为代码行为；`npm test` 与 `npm run typecheck` 双绿。

---

## 4. 实施记录（2026-10-07）

- D1 已实施：AGENTS.md / AGENTS.en.md 目录结构补入 `cc-subagent-rows.ts`、`subagent-presentation.ts`、`pi-proto-adapter.ts`。
- D2 已实施：ARCHITECTURE.md / .en.md §3 的 user-bar 补丁从"load（jiti）"段移到 `session_start → enable` 段。
- D3 由 P0-2 批次处理（core-bus client 落地时一并改写三处注释）。
- D4 已实施：`plan.md` → `docs/archive/plan.md`，头部加归档横幅；仓库内无其他指向旧路径的链接（已 grep）。
- D5 注释已随 P0-1 落地（macrotask 尽力排序 + generation/native 检查说明）；真实宿主顺序取证（两种加载顺序 + 跨 macrotask await + turn 后 widget 更新）仍 open，XPKG-09-HOST 证据未取得。
- D6 已实施：`showNativeFooter` 时跳过 hush 调度（`session_before_compact`）。其专项断言按本表约定落在 P2-1 的 `replica-session.test.ts`（footer mode 为方法参数后可直接表测）；P2-1 未落地期间由 entry 生命周期测试间接覆盖该路径不抛错。
- D7 已随 P0-1 实施（statusline stdin 写 `activeInput`）。
- D8（ANSI 小工具合并）按决策 P2 保持"顺手才做"，本批未做，仍可选。
