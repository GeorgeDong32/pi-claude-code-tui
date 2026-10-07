# A8 Manual Verification Checklist (1.4.2)

> Context for what each item is testing lives in [ARCHITECTURE.md](ARCHITECTURE.md)
> (§4 rendering takeover, §5 statusline protocol).

Automated tests pin the data layer (cc-rows golden, status-snapshot, pm-capability)
but rendering is inherently visual — `node --test` cannot see a frame advance or a
resize artifact. Run this in a real terminal after installing 1.4.2. Each item notes
what the code path is and what "broken" looks like, so a failure can be triaged
without re-deriving the design.

Setup: pi with this extension enabled, ideally alongside pi-permission-modes ≥ 2.7.0
(for item 5). Use a real project with a git repo so usage stats accumulate.

## 1. Spinner frame advance (working state)

Send a prompt that takes ≥5s (e.g. "write a file with 200 lines, slowly").

- [ ] The working spinner frames cycle (braille/verb animation advances), not a
      static glyph.
- [ ] The rotating working verb comes from `setWorkingMessage` /
      `indicator.setMessage` live rotation (C3 step 2) — you should see different
      verbs over a long turn, not one verb for the whole turn.
- [ ] When the turn completes, a `✻ <verb> for <duration>` line appears in the
      status widget (bottom), **not** injected into the chat transcript (A8).

Broken looks like: frozen spinner for the whole turn; completion line appearing
as a chat message; status widget flickering or duplicating per frame.

## 2. Cursor blink

- [ ] Focused input: cursor blinks at a steady cadence.
- [ ] Unfocused (e.g. while a background panel owns focus): cursor stops
      blinking (steady, no ghost blink).

## 3. Resize without artifacts

With history on screen and a spinner running, resize the terminal window:

- [ ] No residual/leftover rows (garbage lines from the previous frame width).
- [ ] The status row and input box reflow to the new width; no truncation of the
      usage segment at narrow widths (it should compress, not overflow).
- [ ] Shrinking then re-widening restores the full layout (no permanent clip).

## 4. Usage row (status-snapshot)

After at least one completed turn with token usage:

- [ ] The usage segment (tokens / cost / duration per UsageTracker) appears in
      the status row and updates at `message_end` — i.e. right when the turn
      finishes, without a full re-render flash of the transcript.
- [ ] It does **not** update mid-stream per token (streaming frames leave it
      alone; only message_end/session_start refresh it).

## 5. B7 pm capability bridge (with pi-permission-modes ≥ 2.7.0)

Start pi with both extensions enabled, with a permission mode active (e.g.
`/permission-mode plan` or whatever the pm command surface is):

- [ ] The PM mode chip renders (e.g. ⏸⏸/plan/edit style marker) and reflects
      mode switches live.
- [ ] While a pm-supervised turn runs, the working-stats segment appears
      (from `__piPermissionModes.workingStats`); it disappears when idle.
- [ ] Without pm installed, no chip and no errors — the row degrades cleanly
      (readPmStatus returns null → segment omitted, not rendered as "undefined").

Broken looks like: chip showing stale mode after a switch; `[object Object]` or
"undefined" text in the row; pm missing but the row still reserving space.

## 6. Tool-call rows (cc-rows golden layer, visual spot check)

Trigger a tool call (edit/bash) that needs approval and one that runs:

- [ ] Tool-call rows match the CC visual grammar (verb-colored title,
      expandable body via ctrl+o or the keyText("app.tools.expand") fallback).
- [ ] Expanded body renders monospaced content with no width overflow at the
      terminal edge.

## 9. Statusline (plan SL4/SL5 — CC-compatible external script)

Requires bash + jq. Toggle with `/claude-statusline`; the bundled default
script renders `~dir │ ◆branch dirty │ model │ Ctx p% (u/w) │ $cost`.

- [ ] Default (statusline off): the belowEditor area shows exactly the old
      mode/hints row — byte-identical to 1.4.5 (no blank rows, no duplicates).
- [ ] `/claude-statusline` on (native footer on AND off): script rows render
      ABOVE the mode/hints row; no second copy of model/ctx/cost in the
      spinner row (right group collapsed).
- [ ] Badge: `model·effort` right-aligned on the first script row; wide
      script output → badge omitted, output itself never truncated.
- [ ] Completion line after a run ≥1s: dim gray `✻ Baked for Xs · HH:MM`
      (end time in local time), no longer accent-colored.
- [ ] Custom script: `/claude-statusline set ~/.claude/statusline-command.sh`
      → your CC statusline renders verbatim (ANSI, 1–2 adaptive rows).
- [ ] Refresh triggers: after each assistant reply, after model switch,
      after compaction, on terminal resize — NOT on every keystroke/frame.
- [ ] Failure path: `set false-cmd` three times in a row → dim
      `<statusline> cmd failed (…) — /claude-statusline off`; a subsequent
      successful refresh restores output.
- [ ] Prefs: toggle `/claude-tools` and `/claude-statusline` in one session,
      restart — both survive in claude-tui.json, neither key wiped.
- [ ] Perf sanity: `node scripts/bench-statusline.mjs` — p50 ~30ms for the
      default script on a quiet machine (bash fork floor ~25ms; refreshes
      are async and event-driven, never on the render path).
- [ ] Force-mode obs_recall row (`/claude-tools on`, then trigger an
      obs_recall): the call row reads `⏺ obs_recall(obs_xxxx · +N.NKB)` —
      the TR D2 summary format, now single-sourced from the callArgsFor
      table. Broken looks like the raw `@bytes` offset format returning.
- [ ] Skill expansion gutter: trigger a skill, expand (ctrl+o) — ONE ⎫
      gutter on the first body row, continuations aligned with 5 spaces,
      same shape as tool-result blocks (now the shared gutter-wrap helper;
      byte-pinned by cc-skill-row tests).
- [ ] cc-status three states: while generating (spinner + verb + shimmer),
      during /compact ("Compacting context…" on the same line), idle after a
      ≥1s run (dim `✻ Verb for Xs · HH:MM`). Weird sequences worth one pass:
      /compact landing mid-run (spinner must not stall), /claude-tui off
      mid-run (no orphan tick — a later requestRender proves the timer died).
- [ ] Footer mode chip: with pi-permission-modes cycling shift+tab — icon +
      label from MODE_META (◐ plan mode on…), unknown modes fall back to ●;
      the chip never blanks the footer when no mode is published.
- [ ] Assistant body color: plain prose renders white, headings/quotes/code
      fences keep theme colors; user messages keep the full-width grey bar
      with ❯ (both now live in lib/cc-markdown.ts — visually unchanged).

Broken looks like: statusline row flickering on every keystroke (per-frame
spawn — regression of the debounce); blank row between script rows and the
hints row; toolRows/statusLine keys overwriting each other in the prefs
file; badge overlapping wide CJK output.

## 10. Subagent Fleet 底栏（展示 seam，spec P4 验收）

前置：pi-subagents 装上 presentation-seam 分支（≥ 7ce8518），本包 ≥ a785ccb。

- [ ] 底栏外观与本仓库 CC 视觉语言一致：`● main` 实心标记、agent 空心 `○`、树分支 `├─/└─` 明确父子、右侧紧凑 `tok·time`（如 `8.1k·16s`，dim）。
- [ ] 无原生折叠摘要行（"N active agents · ↓/← to inspect"）——那是无 CC-TUI 时的原生形态；出现即说明 bridge 未注册（查 console 的 `[claude-tui] subagent fleet drawing fell back to native`）。
- [ ] 默认展开；`↓`/`←`（编辑器空且聚焦）进入选择：`>` 箭头原位替换标记列，行与右列不跳列；`↑` 在顶部退出；Enter 开 inspector（main 上 Enter 退出）；Esc 退出。
- [ ] 超行预算：>6 行时出现 `↓ N more`（滚动后 `↑ N more`），选中项始终可见。
- [ ] 40/60/80/120 列与极窄 20 列：无异常、无错位；窄宽度先保标记与身份，token/time 退让。
- [ ] `/claude-tui off` → 底栏立即恢复原生形态（折叠摘要行 + 交互时上游样式）；`/claude-tui` 再开 → CC 底栏回来。
- [ ] workflow 底栏：wrapper 行右侧 "usage on child rows"、phase 行（`● Tasks · …`）、完成 lane `✓ name · complete · 8s · ↓ N window · M spent`。
- [ ] **async widget**（`subagent-async` 下方面板，多开后台任务时可见）：CC 视觉语言——`● subagents · background` 头、树连接符 `├─/└─`、detail 行 CC `⎿` gutter、折叠态单行 `● subagents (N/M running, …)`；`/claude-tui off` 后回到原生 `⠋ Async agents · background` 形态。极窄终端（<22 行）下是原生渐进卡片（v1 已知降级，见 spec/notes/async-surface-plan.md）。
- [ ] 对应 async 树被 Fleet 完整覆盖时折叠（coverage），不完整时保持双显——中途 resize/展开不应闪烁丢行。

## 11. Lifecycle fixes (spec 2026-10-07 P0-1) — executed 2026-10-08 (see the [evidence ledger](evidence/2026-10-08-host/LEDGER.md))

These are the host-timing/visual counterparts of the automated
`test/entry-lifecycle.test.ts` / statusline runner suites.

- [x] **`pi -p "hello"` output has no thinking tip** and the print session
      writes no `cc-tui/observation-packed` entry (check the session file
      afterwards). Broken looks like: the one-time "ctrl+t toggles collapsed
      thinking" tip appearing in `-p` output, or packed rows in child sessions.
      *Evidence: run/ht1 print-mode logs — stdout exactly `ok`, 0 packed entries.*
- [x] **TUI `/reload` round-trip**: after `/reload`, a repeatable core
      configuration warning still displays (isolated test config — see the
      P0-2 joint protocol in §13; do not assume a CLI flag name).
      *Evidence: run/ht1 — `--effort ultra` (core flag) warns each start, no
      accumulation. Cross-package note: core's effort warning itself
      double-displays (its DC3 dual-write), with AND without cctui — core's
      issue, not this package's.*
- [x] **`/claude-tui off → on`**: header/editor/status widget all return; no
      duplicate thinking tip; packed rows and notifications behave.
      *Evidence: run/ht1 after-off/after-on snapshots — header + footer chip
      gone and back; tip exactly once across the cycle.*
- [x] **Shutdown cleanliness**: quit pi after a run — no lingering
      statusline child processes (`ps` while a slow custom script would have
      been in flight) beyond the TERM→KILL window.
      *Evidence: run/ht1c — `sleep 30` script in flight at quit; no survivor
      3s later.*

## 12. Core tool display (spec 2026-10-07 P1-1) — executed 2026-10-08 (see the [evidence ledger](evidence/2026-10-08-host/LEDGER.md))

- [x] **Force mode goal rows**: with `toolRows: true` (or `/claude-tools on`),
      the core goal-family tools render one-line CC rows —
      `⏺ propose_goal_draft(verify goal row rendering end to end)`
      (spec-era names `goal_question`/`apply_goal_tweak` do not exist in
      core; its actual family is `propose_goal_draft`/`get_goal`/`plan_ready`),
      and `⏺ get_goal({})` shows the bounded JSON fallback. *Evidence:
      run/ht2b.*
- [x] **Generic schema rows**: any newly registered core tool with a
      recognizable top-level string param summarizes without a per-name
      branch; tools with no schema window render the bounded JSON fallback.
      *Evidence: run/ht2b (schema summary + `{}` fallback).*
- [x] **obs_recall**: an error recall keeps its raw text —
      `⏺ Recall Observation(obs_nonexistent1 · start)` +
      `⎿ Unknown observation id: obs_nonexistent123` (multi-page header
      needs a populated pack; error path exercised live). *Evidence: run/ht2.*
- [x] **Proxy / direct MCP rows**: a direct-named MCP tool
      (`mcp__dummy__echo_search`, local stdio server) renders
      `⏺ dummy - echo_search (MCP)(query=mcp row)` + `⎿ dummy echo: mcp row`.
      Host fact: `--no-extensions` also disables MCP registration. *Evidence:
      run/ht2f (bare `mcp` proxy shape covered by the unit mirror +
      `run/ht2d` probe).*

## 12.5 Usage numbers shown once (spec 2026-10-07 P1-2) — executed 2026-10-08 (see the [evidence ledger](evidence/2026-10-08-host/LEDGER.md))

- [x] During a run with core publishing workingStats, the cc-status row shows
      cost and ctx% exactly once: while the statusline script has output the
      numbers live on the script row and the core segment keeps only
      ↑/↓/R/tok-s; with the statusline disabled/pending/failed the RIGHT group
      shows them and the core segment drops `$…` / `…% ctx`. A true zero
      (`$0.000`, `0% ctx`) counts as present (never dropped as "missing").
      `pi -p`-style sessions and native-footer mode show no extra copies.
      *Evidence: run/ht1 (script row `Ctx 0% (0/1M)`, right collapsed),
      run/ht3 (off → right group `Ctx 1%(10k/1.0M)│$0.0008`; native footer →
      pi stock line only), run/ht4a (mid-run `↑3k · ↓64 · ⚡10 tok/s` +
      right group), run/ht3c (persistent error row + self-heal). Waiting
      state is transient (<300 ms) — holder matrix table-tested. NOTE: the
      "set false-cmd three times" recipe below cannot reach the 3-failure
      threshold (each `set` recreates the runner and resets the counter) —
      use `set` once plus real turns (message_end refreshes).*

## 13. Core-bus handoff (spec 2026-10-07 P0-2) — executed 2026-10-08 (see the [evidence ledger](evidence/2026-10-08-host/LEDGER.md))

Automated joint fixtures (`test/core-bus.joint.test.ts`) drive the real core
bus/notify/fallback for the three review scenarios; the items below are the
host-timing counterparts that automation cannot see. Use an ISOLATED test
agentDir/settings fixture (PI_CODING_AGENT_DIR to a temp dir); never touch the
daily settings. Record host version, both repo revisions, launch args, result.

- [x] **Both load orders + a repeatable config warning + `/reload`**: with a
      deterministic warning source (e.g. an invalid effort pin or profile in
      the isolated settings), start pi with extensions in core-first order,
      `/reload`, confirm the warning shows exactly once; repeat with cctui
      first. Do not assume a CLI flag name — use whatever the isolated config
      can trigger deterministically.
      *Evidence: run/ht1 (core-first) + run/ht4a (tui-first) — `--effort
      ultra` warns per session_start in both. Per-item display is doubled by
      core's own DC3 dual-write (see ledger H-T1b); cctui's channel shows
      each item once (joint C1–C3 fixtures).*
- [x] **`/claude-tui off → on` + native footer toggle**: notifications, packed
      rows and the footer show no unexpected duplicates; after off the footer
      slot is the host stock footer (no cc-footer widget, no downgrade row);
      after on the rows return.
      *Evidence: run/ht1 after-off/after-on, run/ht3 native-footer.*
- [x] **TUI load failure after reload** (isolated fixture with a deliberately
      broken cctui entry): core's own session_start paths own the display —
      the footer slot and warnings come from core, not a stale replica.
      *Evidence: run/ht4e — mid-session entry break + `/reload`: session
      survives, core fallback warnings + core modes footer + stock usage
      line, no stale cc surfaces. (Startup-time breakage aborts pi entirely —
      run/ht4c — a different host behavior, recorded.)*
- [ ] **Economy downgrade row**: with the observation-pack degraded in the
      isolated fixture, the dim `[core] … degraded` row appears between the
      statusline rows and the hints line, in both footer modes.
      *OPEN — cannot be triggered on this host: `probePiCompat` gates on
      `pi < 0.87.0` (host is 1.0.2) and exposes no override; patching core is
      out of scope. Recovery: re-run on a pi < 0.87 host. The rendering path
      is covered by joint C6 + composeFooterLines tables.*


## 14. 2026-10-08 follow-up evidence ledger — terminal items executed; economy row OPEN

Current implementation baseline: TUI `1bf9b7f` + the 2026-10-08 follow-up
commits (U-F1 basis fix, J-USAGE joint suite, H-T evidence), core `ff81050`
(fixed snapshot; D4 reader withdrawal included), pi host 1.0.2. Automated
status: 278 passing / 0 skipped tests + clean typecheck;
`test/modes-producer.joint.test.ts` drives the REAL core modes producer
through the real bus into this package's real entry wiring (status row +
statusline JSON through the actual script protocol) — factory-fixture-level
evidence. H-T1–H-T5 terminal evidence was executed on 2026-10-08 via a PTY
driver with pyte screen emulation — see the
[host evidence ledger](evidence/2026-10-08-host/LEDGER.md) (per-item logs and
visible-screen snapshots). Remaining OPEN: the economy downgrade row (host
version gate) and the multi-page obs_recall header (needs a populated
observation pack). XPKG-09-HOST ordering evidence delivered (both load
orders, live widget updates; best-effort semantics described, not a general
async guarantee).

The pre-existing cross-module reload ownership observation for
pi-proto-adapter is a separate investigation, not a completed fix or a reason
to silently skip an affected terminal scenario.
