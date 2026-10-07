# H-T1–H-T5 host/terminal evidence ledger — 2026-10-08

Spec: [2026-10-08 follow-up §4](../../../spec/2026-10-08-followup-validation.md);
checklist: [manual-verification §11–§14](../../manual-verification.md).

| Fact | Value |
|---|---|
| Host | pi 1.0.2 (`/Users/gd32/Library/pnpm/pi`) |
| TUI revision | `632d4e8` (worktree = repo `extensions/claude-code-tui.ts`, loaded via `-e`) |
| core revision | `ff81050` — fixed snapshot via `git archive` (sibling tree was mid-change; recipe in spec §9) |
| Isolation | per-scenario `run/<sc>/agent` (`PI_CODING_AGENT_DIR`; settings `packages: []`), `run/<sc>/proj` (fresh git repo); credentials copied locally for model turns and DELETED afterwards |
| Driver | `pty_driver.py` (stdlib pty + pyte screen emulation; raw byte log + `NNNNNms-*.txt` visible-screen snapshots per run) |
| Reproduce | `bash setup_env.sh <sc> with-auth` then the driver command recorded in each scenario below |

Evidence levels in this ledger: **T** = real terminal (PTY, visible screen),
**P** = real host process non-PTY (print mode), **F** = factory fixture
(`test/modes-producer.joint.test.ts`), **U** = pure-function unit tests.

---

## H-T1 lifecycle — PASS

- **a. print mode clean** (`run/ht1/print-mode.*.log`, level P):
  `pi --no-extensions -e core -e tui -p "Reply with exactly: ok"` → exit 0,
  stdout is exactly `ok` — no thinking tip. Session file
  (`run/ht1/agent` since deleted) inspected at run time: **0**
  `cc-tui/observation-packed` entries, entry types only
  session/model_change/thinking_level_change + user/assistant messages.
- **b. /reload round-trip, repeatable warning** (`run/ht1/tui-session.log` +
  snapshots, level T): `--effort ultra` (core-registered flag) warns at every
  session_start; after `/reload` the warning shows again (stable, no
  accumulation). ⚠ Cross-package finding: the warning displays **twice per
  session_start with AND without cctui** (`run/ht1b` core-only control = 2)
  — core's effort module still dual-writes (tail queue + direct
  `ctx.ui.notify`, its own `DC3` TODO); TUI's own channel displays each item
  once. Not fixed from this repo; recorded for core.
- **c. off → on** (`run/ht1/12014ms-after-off.txt`, `16027ms-after-on.txt`):
  after `/claude-tui off` the header ("Let's build something great") and the
  cc footer chip are gone; `/claude-tui` (on) restores both; thinking tip
  appears exactly once across the whole cycle (startup only — absent after
  reload AND after re-enable).
- **d. shutdown kills the in-flight statusline child** (`run/ht1c`, level T):
  prefs `statusLine.command = "sleep 30; echo …"`; quit (ctrl+c) while the
  child is in flight; 3s later `ps` shows **no** `sleep 30` survivor — the
  TERM→KILL escalation works.

## H-T2 core tool display — PASS (MCP included)

All level T, `run/ht2b` + `run/ht2f`, `/claude-tools on`, bypass mode, real
model turns (glm-5.3-flash via CPA):

- `⏺ propose_goal_draft(verify goal row rendering end to end)` — generic
  schema-driven summary (the spec-era names `goal_question`/`apply_goal_tweak`
  do not exist in core `ff81050`; its goal family is `propose_goal_draft` /
  `get_goal` / `plan_ready`).
- `⏺ get_goal({})` — no usable schema window → bounded JSON fallback row.
- `⏺ session_recall(statusline)` — named rule (query composition).
- `⏺ Recall Observation(obs_nonexistent1 · start)` + `⎿ Unknown observation
  id: obs_nonexistent123` (`run/ht2`, bogus-id call) — named summary + raw
  error text preserved.
- `⏺ dummy - echo_search (MCP)(query=mcp row)` + `⎿ dummy echo: mcp row`
  (`run/ht2f`) — local stdio MCP server (`dummy_mcp_server.py`, tool
  `echo_search`): CC userFacingName shape `server - tool (MCP)` + badge.
  Host fact discovered: **`--no-extensions` also disables MCP registration**
  (probe `run/ht2d`: no `mcp__dummy__echo_search` with `-ne`, present
  without) — H-T runs needing MCP must drop `-ne` (settings `packages: []`
  keeps discovery empty anyway).

## H-T3 usage attribution — PASS

Level T; `run/ht3*` (real turn "Say exactly: ok"):

- Script row owns the numbers: default script renders
  `… │ Ctx 0% (0/1M)` on the script row with the right group collapsed
  (`run/ht1/21003ms-after-statusline.txt`; true zero shown, not dropped).
- statusline off → right group is the holder:
  `GLM 5.3 Flash·high│Ctx 1%(10k/1.0M)│$0.0008` after a real turn
  (`run/ht3/12007ms`), consistent with pi's own native line
  `↑10k ↓13 $0.001 1.0%/1.0M` (`27017ms`).
- Native footer mode (`/claude-footer on`): cc-status hidden, pi stock usage
  line shows, no cctui duplicate (`27017ms`).
- Structured left segment live mid-run: `✢ … ↑3k · ↓64 · ⚡10 tok/s` with
  right group `Ctx 1%(9k/1.0M)│$0.0003` (`run/ht4a/17030ms`).
- Error path (`run/ht3c`): `set false-cmd-xyz` + real turns → dim
  `<statusline> cmd failed (exit 127) — /claude-statusline off`; `set echo
  healed2` self-heals. ⚠ Finding: the manual's "set false-cmd three times"
  recipe does NOT reach the persistent-error threshold — each `set` recreates
  the runner and resets the failure counter; only refreshes that keep the
  runner (message_end/turns) accumulate. Manual updated accordingly.
- Waiting state: not deterministically snapshottable (transient <300 ms);
  holder-matrix equivalence covered by `cc-status-line.test.ts` tables +
  the off/error states above.

## H-T4 footer/notifications/reload-failure — PASS except economy row (OPEN)

- Both load orders (`-e core -e tui` vs `-e tui -e core`): warning repeats
  once per session_start in both; `/reload` round-trips
  (`run/ht1`, `run/ht4a`).
- TUI load failure AFTER reload (`run/ht4e`, level T): in-package wrapper
  entry overwritten mid-session with a throwing factory → `/reload` shows
  `Failed to load extension: mid-session break` as a message, session
  SURVIVES, core's own surfaces own the display (effort warnings via core
  fallback, `● Ask (shift+tab)` core modes footer, pi stock usage line; no
  stale cc footer/status). Contrast: a broken entry at STARTUP aborts pi
  with an error screen (`run/ht4c`) — different host behavior than the
  manual assumed; recorded.
- **Economy downgrade row — OPEN**: `probePiCompat` gates on
  `pi < 0.87.0` only (core `lib/pi-compat.ts` `MIN_PI_VERSION`); host is
  1.0.2, no env/config override exists to force the degraded path, and
  patching core is out of scope. Recovery: run this checklist on a pi
  < 0.87 host (or a core-side test hook). The rendering itself (footer
  channel → dim row between script rows and hints) is covered by
  `core-bus.joint.test.ts` C6 + `composeFooterLines` tables.

## H-T5 XPKG-09-HOST widget order — PASS (best-effort semantics described)

Level T; goal active (`/goals-set`), mid-turn snapshots in BOTH orders:

- tui-first (`run/ht4a/17030ms-mid-turn.txt`): core goal block
  (`● Goal running · auto · 6s · 3.2K (3,213) tokens · $0` + objective +
  goal file) renders ABOVE the cc-status spinner; spinner row
  (`✢ Sublimating… (7s · esc to interrupt) ↑3k · ↓64 · ⚡10 tok/s`) sits
  directly ABOVE the editor.
- core-first (`run/ht4b/15043ms-mid-turn.txt`): identical stacking.
- The goal block updated live mid-turn (token counter advancing) while the
  spinner stayed adjacent — the observed end-state order holds in both load
  orders with a late-mounting widget (goal set ~10 s after startup, i.e.
  after cctui's requeue macrotask).
- Honest scope: this is the documented best-effort ordering (structural
  placements + the requeue macrotask), NOT a guarantee against arbitrary
  async extension orderings — matches the spec's "不承诺对任意异步扩展恒定排序".

## Cleanup

Per run: driver ctrl+c → pi exit recorded in the raw log tail
(`<<<DRIVER exit=0 …>>>`); no lingering statusline/sleep children (H-T1d
check); `run/*/agent` (incl. credential copies) and the core snapshot were
deleted after evidence extraction; `run/*/proj` git dirs remain for
reproduction. `.venv` (pyte) is gitignored and recreatable via
`uv venv .venv && uv pip install pyte`.
