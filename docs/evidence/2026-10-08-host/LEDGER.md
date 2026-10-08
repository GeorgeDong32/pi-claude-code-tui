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
- **d. shutdown kills the in-flight statusline child** (`run/ht1d`, level T):
  prefs `statusLine.command = "sleep 30; echo slow-done"`; quit (ctrl+c)
  while the child is in flight; the captured `ps` check 3s later
  (`run/ht1d/lingering-check.txt`) shows **no** survivor — the TERM→KILL
  escalation works. Raw PTY capture in `slow-statusline-quit.log`
  (driver exit=0).

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
(`<<<DRIVER exit=0 …>>>`); no lingering statusline/sleep children (captured:
`run/ht1d/lingering-check.txt`); `run/*/agent` (incl. credential copies) and
the core snapshot were deleted after evidence extraction (snapshot recipe in
spec §9); `run/*/proj` git dirs stay LOCAL only (gitignored). Raw `*.log`
captures are committed alongside the `*ms-*.txt` screen snapshots (the
evidence dir's `.gitignore` re-includes them against the root `*.log` rule).
`.venv` (pyte) is gitignored and recreatable via `uv venv .venv && uv pip
install pyte`. The H-T1a packed-entry check ran live on the session file
before deletion (0 entries).


---

# Follow-up batch (same day, second session) — corrected pair: core `e98ce4a` + TUI `d846302`

The user-directed follow-up re-verified the notification fix (core's effort
dual-write, fixed at core `25c38b2`) and closed the first batch's gaps:
the goal-family tool names it wrongly reported as nonexistent, the
multi-page obs_recall header, three MCP display shapes beyond native, the
statusline WAITING state, and the XPKG-09-HOST macrotask row. Environment
unchanged (pi 1.0.2, same driver/isolation); the fixed core snapshot lives
at `run/core-snap-e98ce4a` (git archive recipe as before). New probes:
`probe-mcp-shapes.ts` (proxy `mcp` / direct `dummy_echo` / bare
`mcp_bareprobe` — pure echo tools through the REAL pi factory render path;
pi 1.0.2 exposes only codemode/deferred/direct/hidden, so the proxy form
has no bare-host producer without pi-subagents) and `probe-late-widget.ts`
(aboveEditor widget registered AFTER a session_start macrotask await).

## H-T4r — notification single-display re-verification after the core fix — PASS

- Core-only (`run/ht4r-a`, level T): startup warning displays EXACTLY ONCE
  (first batch: twice); after `/reload` the fresh warning displays once more
  (screen total 2 = 1 persisted + 1 new; raw-log clusters confirm two
  firings, never a doubled one).
- Both TUI orders (`run/ht4r-b` core-first, `run/ht4r-c` tui-first, level
  T): startup displays the warning exactly ONCE each; the post-reload
  re-fire is visible in the raw log (late cluster) — the earlier row had
  scrolled by snapshot time.
- off/on handover (`run/ht4r-d`, level T): after `/claude-tui off` a NEW
  goal-module warning ("No goal is set.") displays exactly once via core's
  fallback; after `/claude-tui` re-enable a SECOND identical-text warning
  displays exactly once via the TUI channel — no text-dedup masking, no
  double display. (Note: `/claude-tui off` is a runtime toggle and does
  not survive `/reload` — TUI semantics, recorded.)
- The first batch's "warning displays twice" observations were the core
  DC3 dual-write, now fixed at the core revision under test.

## H-T2 follow-ups — PASS

- **Correction of the first batch's error**: `goal_question` and
  `apply_goal_tweak` DO exist in core (drafting/tweak-gated). Real-flow
  rows captured (`run/ht2g`, level T, real model turns):
  `⏺ goal_question(The current objective reads "Water the office fern twice a …)`
  during a `/goal-tweak` interview, and
  `⏺ apply_goal_tweak(Replaced the vague "twice a week" with fixed watering days:…)`
  (also `⎿ Goal tweak applied. …`). The tools are schema-gated on the
  drafting phase — asking outside it correctly reports them unavailable
  (observed live).
- **obs_recall multi-page + error original** (`run/ht2i`, level T): after a
  real `seq 1 30000` turn, `⏺ Observation Packed(bash · 2.7k tokens
  avoided)` + `⎿ obs_a0942d7fa719… · recall via obs_recall`; a bogus-id
  recall keeps the raw error (`⎿ Unknown observation id: …`); the real-id
  recall renders the pagination header
  `⎿ 2.3KB · 398 lines · start→+2.3KB · more ▸` + content rows +
  `+397 lines (ctrl+o to expand)` (next_offset=2388, eof=false — more pages
  remain).
- **MCP five-shape display, four newly on the real path** (`run/ht2h`,
  `run/ht2h2`, level T):
  - native: real stdio server (`dummy_mcp_server.py`, mcp.json exposure
    "direct" so the tool is model-callable — default codemode exposure keeps
    it code-only):
    `⏺ dummy - echo_search (MCP)(query=native shape)` + `⎿ dummy echo: native
    shape` (visible in the pyte replay of the raw log, `reply-screen.py`;
    the snapshot missed it by seconds on a latency spike).
  - proxy: `⏺ dummy - echo_search (MCP)(tool=mcp__dummy__echo_search
    args={"query":"proxy shape"})` + `⎿ probe proxy echo …` — the
    `mcp`-named tool with the real target in args.tool (probe-sourced; the
    historically real producer is pi-subagents' codemode bridge).
  - direct (env allowlisted): with PI_CORE_MCP_DIRECT_SERVERS=dummy,
    `⏺ dummy - echo (MCP)(note=direct shape)` — the bare `dummy_echo` name
    claimed through the same env var core's mcp-gov reads (probe-sourced).
  - bare: `⏺ mcp_bareprobe({"note":"bare shape"})` — NO (MCP) badge, JSON
    fallback row; the display does not claim un-split `mcp_*` names.
  The first batch's `mcp__dummy__echo_search` native evidence stays valid
  (same shape re-captured here on the corrected pair).

## H-T3 follow-up — WAITING state stably captured — PASS

- `run/ht3w` (level T): slow script `sleep 4; echo …` set via
  `/claude-statusline set` (unquoted — a quoted set stores the quotes and
  fails with exit 127, itself captured as the error state). Frames during
  the post-turn in-flight window: NO script row, NO error row, and the
  right group HOLDS the numbers (`GLM 5.3 Flash·high│Ctx 1%(7k/1.0M)│$0.0006`)
  — the waiting state, previously "transient <300 ms, not deterministically
  snapshottable", now held open for seconds by the controlled slow script.
  sleep 4 exceeds the runner's script timeout → `<statusline> cmd failed
  (timeout)` (bonus: the timeout flavor of the error state).
- `run/ht3w2` (level T): with `sleep 1` the script row lands
  (`SLOWSCRIPT-ROW-ACTIVE` + `● high · /effort` badge) and the completion
  line's right group stays collapsed — script-valid state on the corrected
  pair. Off/native-footer/error/true-zero cells stay covered by the first
  batch (TUI unchanged since; core's usage channel untouched by its later
  commits).

## H-T5 follow-up — XPKG-09-HOST macrotask row — PASS (boundary described)

- `run/ht5m-core-first` / `run/ht5m-probe-first` (level T): the probe's
  session_start handler awaits an 80 ms macrotask before setWidget.
  - core-first: goal block on top, late probe widget directly BELOW it,
    above the editor.
  - probe-first: the probe handler STARTS first but completes after its
    await; pi runs session_start handlers sequentially, so the goal widget
    registers during the await and the probe lands ABOVE the goal block.
  In BOTH orders the goal block kept its position relative to the
  status/spinner area directly above the editor. Honest semantics: pi
  awaits each session_start handler in registration order; aboveEditor
  widgets stack by REGISTRATION-COMPLETION order — a macrotask-crossing
  handler therefore reorders itself after everything that registers during
  its await. This is the documented best-effort ordering's boundary, NOT a
  guarantee against arbitrary async extensions (matches the spec wording).

## Still OPEN — economy downgrade row

Unchanged from the first batch with refined conditions: `probePiCompat`
gates on `pi < 0.87.0`; the assembly hard-wires the real compiled-in
VERSION into the economy factories (`extensions/index.ts` economy block)
with no env/config override, so no production wiring on pi 1.0.2 can take
the degraded branch. Recovery: (a) a pi < 0.87 host running CORE-ONLY (the
TUI peer requires pi ≥ 1.0.1, so a TUI session on such a host is not a
valid target), or (b) a deliberate core-side test seam for the version
input (adding one solely for this acceptance was ruled out as a
product-switch-for-acceptance). Rendering itself stays covered by joint C6
+ composeFooterLines tables.

## Cleanup (this batch)

Run dirs keep only `*.txt` snapshots + raw `*.log`; `run/*/home` joined
`run/*/agent` / `run/*/proj` in the evidence .gitignore; credential copies
(auth.json/models.json) were present only inside the isolated run dirs and
were deleted after extraction (never committed; gitignore verified with
check-ignore). Stale first-batch probe dirs (ht2c/ht2d/ht2e) were
accidentally removed and restored from git.

---

# Bare-MCP + widget-order correction batch (2026-10-09) — core `c4dab5f` + TUI `eb3bb11`+evidence batch

Same environment and driver as before (pi 1.0.2, isolated
`PI_CODING_AGENT_DIR` + HOME + fresh git proj, PTY + pyte, credentials
copied in only for the model turns and deleted after extraction). Fixed
core snapshot: `run/core-snap-c4dab5f` (C5 encapsulation close-out). TUI
production code is unchanged from `eb3bb11`; `probe-mcp-shapes.ts` was
extended (see below) and is committed with this batch.

## H-T2j — the ACCURATE bare-MCP acceptance — PASS (T level)

The earlier `mcp_bareprobe` evidence pinned the no-separator `mcp_*` NAME
shape, not the scenario this acceptance actually names: a tool named
exactly `mcp` whose `args.tool` is missing / empty / unparseable. The
probe's `mcp` tool now takes `tool` as OPTIONAL/unknown so the model can
send those degenerate inputs through the REAL host render path (probe
only; production tool schemas untouched). One turn, four calls, real
model (glm-5.3-flash via CPA), `/claude-tools on` = force, default =
auto:

| input (name = `mcp`) | force row (`run/ht2j-force/160047ms-final.txt`) | verdict |
|---|---|---|
| `{}` — tool field absent | `⏺ mcp({})` + `⎿ probe proxy echo for {}` | generic JSON row, NO (MCP) badge, no mislabel, no throw |
| `{"tool":""}` — empty | `⏺ mcp({"tool":""})` + echo row | same generic row, args visible (no info loss) |
| `{"tool":"not_a_valid mcp shape 123"}` — unparseable | `⏺ mcp({"tool":"not_a_valid mcp shape 123"})` + echo row | same; the garbage target is displayed verbatim, never claimed |
| `{"tool":"mcp__dummy__echo_search","args":{"note":"control"}}` — VALID control | `⏺ dummy - echo_search (MCP)(tool=mcp__dummy__echo_search args={"note":"control"})` | correctly identified: server-tool shape + badge + args summary |

- **force** (`run/ht2j-force`, level T): table above; the turn completed
  ("done" reply, exit 0) — no throw anywhere in the path.
- **auto** (`run/ht2j-auto`, level T, default toggles): the bare `mcp`
  NAME is not an official MCP shape at the resolver level (no args there,
  R5), so the whole tool — degenerate AND valid inputs — auto-yields to
  the host's stock rows (` mcp` + dim args + dim echo, zero `⏺`/`(MCP)`
  glyphs in the raw log). That IS the documented takeover/fallback path:
  auto-yield keeps the stock renderer, args stay visible, no MCP claim.
- Unit level (U): `cc-rows.golden.test.ts` R-T4 gained the missing
  degenerate inputs — `tool:""`, `tool:null`, unparseable string,
  `"mcp_"` near-miss, tool-field-absent — all `null` (prior cases
  `{}`/`undefined`/`{tool:42}`/array/`{tool:"read"}` were already pinned).
  Core's authority (`lib/mcp-shape.ts` canonicalizeMcpShape) returns null
  on the same degenerate inputs (proxy guard `typeof input.tool ===
  "string"` + truthiness) — no badge AND no permission-side misclaim.
- Implementation verdict: NO display defect found (reproduced first, then
  left as-is) — this batch adds evidence + ledger only.

## H-T5 causal correction (2026-10-09, host-source-verified)

The follow-up batch above wrote both "pi awaits each session_start
handler" and "the goal widget registers during the [probe's] await" — the
second claim is WRONG. Verified against the pi 1.0.2 bundle
(`chunk-ZSBPJAJ2.js`, `ExtensionRunner.emit` + `_InteractiveMode.setExtensionWidget`):

1. `emit` iterates extensions in LOAD order, handlers in registration
   order, `await`ing EACH before the next starts. No session_start
   handler of a later extension can begin during an earlier handler's
   macrotask await.
2. `setWidget` stores into an insertion-ordered `Map`; re-setting an
   existing key REMOVES then re-INSERTS (moves it to the tail).
   `renderWidgetContainer` renders `widgets.values()` top→bottom, so the
   LAST-inserted aboveEditor widget sits DIRECTLY above the editor.
3. The goal extension REMOUNTS its widget unconditionally at every
   session_start (`remountWidget`; renders zero lines with no goal, and
   `registerWidget` during later turns/`/goal-set` is idempotent — no
   re-insertion). The cc-status spinner registers via a deferred
   macrotask callback at ITS session_start handler.

Corrected reading of the ht5m screenshots:

- **core-first** (`run/ht5m-core-first/19011ms-late-landed.txt`): goal
  remount (sync, handler #1) → tui schedules its macrotask (handler #2)
  → probe handler (#3) awaits 80 ms; DURING that await only the event
  loop runs, so the tui's timer callback fires and the spinner slot
  inserts BEFORE the probe's setWidget. Result: goal on top, spinner
  slot, probe LAST — the probe sits BETWEEN the status area and the
  editor, NOT "directly below the goal with nothing between" as the old
  wording implied.
- **probe-first** (`run/ht5m-probe-first/19048ms-late-landed.txt`): the
  probe's handler runs FIRST and COMPLETES (82 ms) before the goal
  extension's handler even STARTS (sequential await — nothing registered
  "during" the await). Insertion: probe, then goal (sync remount), then
  spinner (macrotask). Result: probe topmost, goal below it.
- The load ORDER (handler execution order) — not the macrotask —
  determines where the probe lands relative to the goal block. A
  synchronous probe at the same handler position would stack identically.
  What the macrotask await DOES change is the ordering against OTHER
  extensions' timer-deferred registrations (cctui's spinner requeue): a
  macrotask-crossing handler lands AFTER timer callbacks that fire during
  its await.
- The invariant that actually held in BOTH orders: goal block above the
  cc-status spinner slot (goal's remount is synchronous inside its
  session_start handler; the spinner's requeue is a macrotask — the goal
  therefore always inserts first, independent of load order). That is the
  documented best-effort ordering; no guarantee against arbitrary async
  registrations outside session_start (the XPKG-09-HOST todo stays open).

## Still OPEN — economy downgrade row (conditions re-verified 2026-10-09)

Re-checked against core `c4dab5f`: `probePiCompat` gates on
`version < 0.87.0` only (`lib/pi-compat.ts` MIN_PI_VERSION); the assembly
(`extensions/index.ts` economy block) threads the compile-time
`PI_VERSION` into the factories with no env/config override. The
factory-level degrade wiring IS pinned in core
(`extensions/observation-pack/tests/compat-degrade.test.ts`: version
0.85.0 through the real factory → degraded footer line), and the row's
CONSUMPTION/rendering is pinned by joint C6 + `composeFooterLines`
tables. What remains open is the real-host ROW (T level) — structurally
unreachable today: a TUI session needs the pi ≥0.99 renderer-resolver API
(absent on any pi <0.87 host, so "TUI on an old host" is not a valid
target), a core-only old-host session displays via core's own fallback
(not the TUI row), and adding a core-side version override solely for
this acceptance was already ruled out (product-switch-for-acceptance).
Recovery conditions: (a) the user revisits that ruling and accepts a
version-input seam, or (b) a future pi host where the degraded branch is
genuinely reachable with a TUI-compatible API surface.
