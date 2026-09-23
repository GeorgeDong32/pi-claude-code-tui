# A8 Manual Verification Checklist (1.4.2)

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

Broken looks like: statusline row flickering on every keystroke (per-frame
spawn — regression of the debounce); blank row between script rows and the
hints row; toolRows/statusLine keys overwriting each other in the prefs
file; badge overlapping wide CJK output.
