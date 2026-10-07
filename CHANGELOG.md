# Changelog

## Unreleased

### Changed (core tool display, spec 2026-10-07 P1-1)
- Goal-family call rows: `abort_goal` / `apply_goal_tweak` / `goal_question` (previously missing → raw JSON rows in force mode) and the rest of core's registered tools are now summarized by a generic schema-driven rule (`lib/tool-summary.ts`): preferred headline field (objective/query/question/reason/…) or first required string param, from the tool's own parameter schema cached at enable / session_start / mcp_servers_change. Only rules the generic cannot express stay name-based (`obs_recall` id+offset, `memory_consolidate` ops count, `session_recall` since suffix); renderers read the cache only. Visible deltas from the old table: `pi_review_report` shows its `runId` (the old `mode/scope/base` fields no longer exist in core's schema), `step_complete` shows its `evidence` line.
- `obs_recall` result shaping reads the structured `details` first (validated: id non-empty string, finite non-negative numbers, boolean eof) and only strips text lines that verifiably match the protocol patterns; partial/error details never fabricate a paging header; non-text content blocks are preserved in the rebuilt display object (the original result is never mutated).
- MCP display names mirror core's five-shape authority (`lib/mcp-shape.ts`): proxy (`mcp` + `args.tool`) and direct-named (`PI_CORE_MCP_DIRECT_SERVERS`) tools now render `server - tool (MCP)` rows. The resolver itself never claims a bare proxy `mcp` without args — auto mode keeps yielding to its own renderer (R5); a shared-sample test cross-checks the mirror against the real core module.

### Changed (usage single display, spec 2026-10-07 P1-2 step 1)
- The running status row no longer shows cost / ctx% twice: the core-published `workingStats` segment keeps its ↑/↓/R/tok-s parts but drops the `$…` and `…% ctx` segments whenever a replacement holder is on screen (the right group, or the statusline script row when it has output). While the statusline is enabled but has not produced output yet (first run pending / empty / persistent error), the right group now renders as the fallback holder so the numbers never vanish; unknown text segments in the core string are never touched (full-segment numeric match only). True zeros still count as numbers.

### Fixed (lifecycle, spec 2026-10-07 P0-1)
- Non-TUI sessions (`pi -p`, subagent children) are stock again: a guard lost in 1.9.0's packed-events commit let print/RPC sessions declare cctui presence, start bus consumers, install prototype patches, patch the editor, and run statusline scripts.
- `session_shutdown` now releases everything (presence, subagent bridge, obs consumer, statusline runner, run state, editor timer, startup header, prototype patches, stale ctx refs) — a residual presence key used to silence core's notifications/working line forever after `/reload`.
- Startup header no longer reads a captured ctx inside render (the one violation of AGENTS traps 1/3): data comes from entry-maintained getters + the setHeader factory's theme; any failing read degrades to a last-good frame truncated to the current width.
- Statusline runner: every timer is `unref()`d, `dispose()` runs a bounded SIGTERM → 750ms SIGKILL escalation for the in-flight child (previously it cancelled the kill escalation and only sent TERM — scripts trapping TERM survived), repeated dispose keeps the original deadline, `error` events complete the termination flow instead of pretending the child exited, and stdin is fed the launch-time input (`activeInput`) rather than the mutable latest.
- Footer requeue macrotask is generation-guarded and cancelled at teardown; a firing after `/claude-footer on` or a session switch can no longer reinstall a dead widget.

## 1.9.0 (2026-10-06)

### Added (subagent presentation decoupling, spec 2026-10-05-cc-tui-subagent-presentation)
- CC subagent presentation drawing (`lib/cc-subagent-rows.ts`) + seam protocol mirror (`lib/subagent-presentation.ts`): the fleet and async rosters draw in CC style over pi-subagents' versioned presentation seam (P2), wired by `SubagentPresentationBridge` (P3 — probe → register → late-host re-register → withdraw, native fallback on any failure). Async single-line/full tiers follow the seam (P4/step 4); progressive stays native v1 (known degradation).
- Tool rows gain display-only tool names (`displayToolName()`): `obs_recall` reads as **Recall Observation** (the observation pack's own naming) — model-side name/schema unchanged.
- obs_recall result previews lead with a human header (`15.5KB · 241 lines · start→+15.5KB · more ▸` / `… · end ✓`) parsed from the two protocol lines in the result text (no details dependency; non-matching text passes through).
- Observation-pack savings in the conversation flow (user-directed design): on each first-replacement publish (OBS-09-SITES), a display-only CustomEntry renders as a pseudo tool row in the transcript — `⏺ Observation Packed(read · 12.5k tokens avoided)` + `⎿ obs_xxxx… · recall via obs_recall` — never entering the model context, durable across restarts (`appendEntry` + `registerEntryRenderer`).

### Fixed
- User-message bar patch is wrapper-style: the adapter body runs the saved original before clearing padding (the replacement-style regression blanked user messages).
- obs_recall's recall detail renders in the CC result slot (unified ⎿ slot).
- Editor blink timer lifecycle (spec 8.1); usage snapshot samples post-append agent_settled/session_tree/session_compact (spec 8.2); centralized pi prototype adapter with marker-based refresh (spec 8.3).
- Fork visual cleanup (P5) reverted the native roster to upstream 8983754b form; subagent running/completed summary rows keep their CC ⎿ gutter (pi-subagents side `afc6075`).

### Changed
- Result renderer memo removed — hosts rebuild envelopes every updateDisplay, the reference memo never hit (spec 8.4 conclusion).
- Upstream sync drilled 8983754b→6826b054 with zero adapter changes (P6); manual verification checklist expanded (docs/manual-verification.md §10 incl. async).

## 1.8.0 (2026-10-03)

### Changed (tool rows migrate to the official renderer channel, spec 2026-10-03-pi-1.0-tool-renderer-migration)
- Tool rows (builtin seven / third-party / MCP) now render through pi's official `pi.registerToolRenderer` resolver channel (pi >= 1.0.1) — one resolver merges CC renderers with `next()`'s originals per slot (call/result/shell). The pre-1.0 mechanisms (re-registering the builtin seven via `pi.registerTool` + the `ToolExecutionComponent` prototype patch) are gone: tool `execute` is never re-registered, and the jiti multi-instance risk no longer applies to tool rows. Renderer output is byte-identical (golden tests untouched).
- Peer requirement raised to `@earendil-works/pi-coding-agent >=1.0.1` (registerToolRenderer ships in 1.0.1). On pi 0.x the extension still loads (git installs don't enforce peers) but tool rows stay stock with a console warning.

### Behavior deltas (deliberate, reviewed)
- `/claude-tools off`/`auto` yields immediately — new tool calls render stock and other extensions' registrations are no longer clobbered until a `/reload` (the old path re-registered pristine definitions). Toggles apply to newly appearing tool rows; already-rendered rows keep their renderers.
- `/claude-tui off` now restores stock tool rows too (previously CC rows persisted until `/reload` because disable() never re-registered).
- Tools without any definition (resumed-session MCP tools whose server hasn't connected yet, hallucinated tool names) now render as CC rows instead of pi's generic JSON dump.
- The builtin renderer-table's `powershell` key deliberately stays stock (BUILTIN_SEVEN is the seven migrated names only).
- Interactive `/export` and `share` render taken-over rows CC-style; RPC export keeps stock (TUI-only principle).

### Added
- `BUILTIN_SEVEN` / `isBuiltinToolName` / `planResolverTakeover` in `lib/takeover-rules.ts` (single home; matrix isBuiltin route now live — the old `builtInToolDefinition` probe never fired). Table tests cover the full matrix plus the resolver planner, including the yield-path flat-shell regression pin.

## 1.7.0 (2026-10-03)

### Added (TR, spec 2026-10-02-core-tool-renderers)
- Force mode exempts obs_recall dense paged result view (FORCE_RESULT_EXEMPT - same class as subagent); obs_recall args in CC call rows collapse to a short "obs_4b1d7b39 - +15.5KB" form; fused write/edit calls re-state the "then_run: command" badge as a dim second row under the CC row (core own call badge is replaced in force mode). Auto mode unchanged (core renderers flow through natively).

### Fixed
- Startup header's effort label read `pi.getThinkingLevel()` unguarded — a throwing/stale host could kill pi on the render stack. All effort reads now go through one never-throwing seam (`lib/host-status.ts` `readEffortLevel`).
- The run/compaction spinner interval is `unref()`d again (regression of the 2026-10-03 state-machine extraction, caught by code review) — the package's longest-lived timer can no longer hold the event loop open.

### Changed (architecture, zero visual delta — golden render assertions untouched)
- **Tool-row wiring converged** (review 2026-10-03): the obs_recall arg summary has a single definition in the `callArgsFor` table (the force-mode path's local copy is gone — the TR D2 format was already the effective one, so production output is byte-identical); the per-frame component memo is one shared implementation (`renderMemoizedResult`) for both wiring paths (registered overrides + force-mode prototype patch); the ⎿-gutter expansion layout is one shared `gutterWrapRows`/`createWidthCache` pair (ccResult family + skill-row expansion, which is now byte-pinned); the takeover decision matrix (user switches × MCP × builtin × force × exemptions, per call/result/shell slot) is a pure function in `lib/takeover-rules.ts`, pinned by an exhaustive boolean-matrix table test including an edf4fce regression case.
- **Entry slimmed to wiring** (1215 → 1037 lines): the markdown transformer (assistant white paint + user grey bar), the cc-status row composition (right group / left-right join / footer mode chip), and the effort-read seam now live in pure, table-tested lib modules (`cc-markdown.ts`, `cc-status-line.ts`, `host-status.ts`).
- **render-utils drawer dissolved**: dead code dropped (~130 lines: the orphaned 108-word legacy verb table, dead imports, `shortenCwd`, an identity fn) with `noUnusedLocals` on to keep it out; header layout/tips functions homed in their only consumer (`pi-startup-header.ts`, now node-test-loadable via explicit constructor fields); the remaining seven formatters became `lib/format.ts`.
- **Run/compaction state machine** (`lib/run-state.ts`): the seven scattered mutable vars and the double-owned tick timer became one module with injected clock/timer and transition tests (mid-run compact, disable mid-run, throwing-tick containment, ≥1s completion gate).
- **pm-capability**: `readPmStatus` is a pure read now (the DC5b subscription retry used to hide inside it); lifecycle pairs up as `activateCcTuiChannel` / `withdrawCcTuiCapability`, with the entry retrying explicitly at enable / session_start / each status-widget frame.
- Tests 101 → 133 (takeover matrix, memo dimensions, gutter bytes, markdown/cc-status tables, header layout/tips, run-state transitions, pm purity). Docs: AGENTS + ARCHITECTURE (zh/en) module maps refreshed; manual-verification checklist gains six checkpoints for the refactor's visually-sensitive surfaces.

## 1.6.0 (2026-10-02)

### Added
- **CC-style skill invocation row**: pi's native `[skill]` box (customMessageBg, name-only, zero info collapsed) is prototype-patched into the CC tool-row family (`lib/cc-skill-row.ts`, the compaction-row recipe): collapsed `⏺ Skill(name) (ctrl+o to expand)`, body expands under the `⎿` gutter with ANSI-aware wrapping. Box chrome stripped so the row sits flush with the tool rows; expansion state stays native so the global ctrl+o walk keeps working; the MouseRegion is re-armed so click-to-expand survives (which the compaction patch drops).
- **`(MCP)` badge on MCP call rows**: MCP rows read `⏺ exa - web_search (MCP)(query)` now — `mcpDisplayName` yields the CC userFacingName core `server - tool` (was the self-invented `server/tool`; CC's `services/mcp/client.ts` builds `server - tool (MCP)`), and `ccCall` grows an optional badge rendered dim between name and args paren (CC dims the same suffix in `FallbackPermissionRequest`). Detector call sites (auto-yield, force gates) only read null/non-null and are unaffected.

### Changed
- **Golden visual delta**: MCP rows `exa/search(query)` → `exa - search (MCP)(query)`, badge routed through theme `dim`; `mcpDisplayName` tests updated accordingly.

## 1.5.0 (2026-09-30)

### Added
- **CC-compatible configurable statusline** (plan `docs/STATUSLINE-PLAN.md` rev3, SL1–SL5): the extension synthesizes a CC-shaped JSON document (model / workspace / context_window, plus `pi.cost_usd`/`pi.effort`/`pi.provider` extension fields — schema verified against `~/.claude/statusline-command.sh`'s jq fields) and pipes it to an external command's stdin; the command's stdout renders verbatim below the editor — script rows first, then the existing mode/hints row. Your existing CC statusline script works unchanged: `/claude-statusline set ~/.claude/statusline-command.sh`. Off by default (zero visual regression); on enable the spinner row's right group (model/ctx/cost) collapses so nothing shows twice, and `model·effort` becomes a right-aligned CC-style effort chip (`⊙ high · /effort`, muted; hidden when effort is unset or off — the script row already names the model, and `/effort` is a real command registered by pi-claude-code-core) on the first script row (omitted when it cannot fit — script output is never truncated). The bundled default script (bash+jq; source at `scripts/statusline-default.sh`, embedded verbatim as `lib/statusline-default-script.ts` because pi's jiti loader evaluates extensions from data: URLs — no import.meta anchor exists — with a byte-sync test pinning the two) renders `~dir │ ◆branch dirty │ model │ Ctx p% (u/w) │ $cost` with a right-to-left degradation ladder. Refreshes are event-driven only (message_end / model_select / session_compact / width change / config change) — debounced 250ms, in-flight coalesced into one follow-up spawn, 2s timeout kill, output capped at 4 lines / 64KB; three consecutive failures surface a dim `<statusline> cmd failed` row that self-heals on the next success. Benchmark harness: `node scripts/bench-statusline.mjs` (default script p50 ≈ 30ms, p95 ≈ 50ms on a loaded machine; bash fork floor ~25ms — advisory, refreshes never touch the render path).
- **`/claude-statusline` command**: `on | off | badge on|off | set <command>`, persisted in `~/.pi/agent/claude-tui.json` under `statusLine` via a new shared read-modify-write prefs store (`lib/prefs.ts`, atomic tmp+rename) — fixes the latent bug where `saveToolRowsPref` serialized `{toolRows}` alone and would have wiped every sibling key.

### Added (CC-parity surface batch + pi 0.99 adaptation)
- **Blinking call dot**: tool-call rows animate their `⏺` dot at 600ms while running (dim grey phase), solid on success/error — aligned with Claude Code's ToolUseLoader cadence; the clock is read inside `render()` so all rows share the blink phase.
- **CC-style compaction row**: `⏺ Context compacted from N tokens` with an expandable `⎿` block (flat, grey-family; no background box), and the native compaction indicator is silenced; the cc-status spinner mirrors compaction progress.
- **`subagentCallSummary` rewrite**: call rows prefer the model-written `label` param, then `agent · path-collapsed task excerpt`, then lane aggregation (`2×scout · key1 · key2 · +N`).
- **Official MCP tools render as CC rows (pi 0.99)**: `mcp__server__tool` renders as `⏺ server/tool(key=value…)` + `⎿` collapsed result — the takeover deliberately overrides pi 0.99's own MCP renderer; the exception exempts only the (never-true) builtin check and the auto-yield, never the user's `/claude-tools` switches.
- **Footer hints relocated** into the cc-footer widget; the freed footer slot lets pi-subagents' fleet roster sit at the bottom edge.

### Changed
- **Turn-completion line goes CC-dim with an end timestamp** (plan D0): after a run ≥1s the status row shows `✻ Baked for 1m 21s · 13:54` (duration + local wall-clock end time) in theme-dim instead of accent — extracted as the pure `buildCompletionLine` for golden tests.
- `formatDuration`/`formatTokens`/`formatCost` moved to `lib/render-utils.ts` (shared with the statusline module); `UsageTracker` now also reports `lastInput/lastOutput/totalInput/totalOutput` from its existing single branch scan (pi-footer mouth for the JSON totals).

## 1.4.5 (2026-09-19)

### Added
- **pi-subagents adaptation — CC-style subagent call rows**: `callArgsFor` routes `subagent` through a new `subagentCallSummary` (`lib/cc-rows.ts`): `workflowScript` is parsed for lane keys (dedup, last path segment, first 2 shown) → `call 5 agents: claude-md-compliance, pr-guardrails, +3`; a single lane or an `agent` call → `call agent(name)`; management `action`s → `stop abc123`; `workflowScriptPath` → `call workflow review.mjs`. Previously force mode printed the whole args JSON — the entire workflowScript, escapes and all — on the call row. Mirrors CC's Agent tool design (count/type up front, names short; CC's grouped block reads `Running 5 agents…`).

### Changed
- **Force mode no longer flattens live subagent results**: `subagent` joins a `FORCE_RESULT_EXEMPT` set — its own renderResult (pi-subagents' live workflow card: per-agent progress, tokens, checklists, ctrl+o detail) stays even under `/claude-tools on`. Taking it over had pushed all live state down into the belowEditor "Async agents" widget and left a bare "Workflow running." line; CC keeps progress INLINE under the call row, and pi-subagents' widget-coverage mechanism hides widget rows already covered by the inline card, so exempting restores that split (foreground call progress inline; only true background tasks stay in the widget). Banner-style renderers (SoL-Pi) remain taken over — they carry no live detail. The call row is still the CC `⏺` row, in the same flat `self` container as the exempt result.

## 1.4.4 (2026-09-19)

### Added
- **Force mode for `/claude-tools on` — third-party renderers are taken over** (SoL-Pi adaptation): the `ToolExecutionComponent` patch used to yield to ANY tool that shipped its own `renderCall`/`renderResult`, so e.g. SoL-Pi's `obs_recall` / `update_plan` kept their three-line `⚡ SoL-Pi · …` banner blocks. With an explicit `on` (`toolRows: true` in `~/.pi/agent/claude-tui.json`), the CC rows now take over every non-built-in tool at render time — and only the renderers swap: `execute` and `parameters` stay the other extension's, so SoL-Pi Action Fusion and Observation Pack behavior is untouched (their savings notices still arrive via notify/status). `auto` keeps the old yield contract. The patch's result factory gained the plan-A6 component memo (it now serves edit diffs / read summaries in force mode) and passes the tool name through, so a third-party override of a built-in name renders the same concise call rows via the shared `callArgsFor` map (`lib/cc-rows.ts`).
- **Thinking-block label, CC style**: pi natively collapses thinking blocks (`settings.json` `hideThinkingBlock`, toggled and persisted by `ctrl+t` / `app.thinking.toggle`) but labels them with the plain italic "Thinking...". When the CC replica is enabled the hidden label becomes `✻ Thinking… (ctrl+t to expand)`; restored to pi's default on disable. One-time `ctrl+t` tip on enable while the user has never set `hideThinkingBlock` explicitly. The collapse choice itself stays pi-native — there is no extension API to set it, and pi already persists the toggle.

### Changed
- `/claude-tools on` notify now states the takeover semantics ("every tool renders as CC rows; execute untouched") instead of the ambiguous "CC tool rows on".

## 1.4.2 (2026-09-12)

### Changed
- **Typed capability channel from permission-modes (plan B7)**: `lib/pm-capability.ts` reads mode and working-stats from the versioned `globalThis.__piPermissionModes` object pm now publishes, falling back to the legacy untyped keys (`__pmWorkingStats` literal-prefix string, `PERMISSION_MODES_INHERITED_MODE` env) for one compatibility cycle — the priority chain has one owner and five pinned tests. This extension likewise announces its presence via a versioned `__piCcTui` object (legacy `__ccTuiActive` kept in sync).

### Changed
- **Declared pi dependency surface (plan B4 step 1)**: `peerDependencies: "@earendil-works/pi-coding-agent" >= 0.85.0` (the first version this fork's `keyText`/tool-renderer usage targets), and expand hints fall back to `ctrl+o` when `keyText` yields an unregistered binding (previously a bare "( to expand)"). Scope note after probing pi 0.85.1: the built-in tool rows already use the official `registerTool` renderCall/renderResult API; the `ToolExecutionComponent` prototype patch remains deliberately — it is the only way to give third-party/MCP tools without their own renderers CC-style collapsed rows (no official surface covers that), now guarded to skip loudly if pi internals move. The spinner stays in the cc-status row: the official border spinner (`embedWorkingStatus` + `setWorkingMessage` live label rotation, verified in pi source) is technically viable, but moving it would scatter the permission-modes working-stats integration and the esc/duration hints that share the row.

### Changed
- **Status-row usage numbers come from a change-derived snapshot (plan A7)**: the cc-status widget re-summed the whole session branch on every render frame (per keystroke and per spinner tick). Usage is now observed once at message boundaries (`UsageTracker`, semantics pinned by tests: used = last assistant cumulative, cost = sum) — equivalent values because pi freezes the branch while streaming. The permission-modes mode-chip table moved to module scope instead of being rebuilt per frame.

### Changed
- **CC tool rows extracted and golden-tested** (`extensions/lib/cc-rows.ts`): the `⏺ Tool(args)` / `⎿ output` renderers moved verbatim out of the monolith with the theme duck-typed and injected, and the fork regained a test suite (`node --test`, 12 cases) pinning exact rendered strings and color-name routing. No behavior change — verified verbatim against the removed block.
- **Timer hygiene**: the editor cursor blinks only while focused (solid cursor when unfocused) and the spinner/blink/completion timers now request non-forced renders so pi's line-diff cache survives; previously every tick forced a full-terminal repaint (~5-10/s combined). Added `npm run typecheck` (tsc --noEmit passes clean) — the fork's first type gate. Visual verification in a live terminal (spinner frames, cursor blink, no stale rows after resize) is still pending.
- **Result rows wrap once, not per frame**: `ccResult` caches its rendered rows per width and the render wiring reuses the component while `result`/`expanded`/`isError`/`theme` are the same references (official slot-local cache pattern). A 10k-line tool output previously cost one ANSI-aware wrap per logical line on every frame; cached renders are now free (~0ms vs 687ms for 200 renders) and terminal resizes recompute.

## 1.4.0

- **Tool rows auto-yield to other TUI suites** — no more manual setup for
  the common conflict. On every session start the extension checks
  `pi.getAllTools()` source metadata; if another extension (e.g.
  minuque/pi-cc-extensions) owns the built-in tool rows, the CC rows stay
  off with a one-time notice. `/claude-tools` gains an `auto` mode
  (back to detection), explicit `on`/`off` still wins and persists, and
  tool registration moved to session start so print/RPC modes always keep
  stock rendering.

## 1.3.1

- **Tool-rows choice persists + load-order note** — `/claude-tools off`
  is now saved to `~/.pi/agent/claude-tui.json` and survives `/reload`
  and restarts (previously it reset to on). README documents the
  recommended combo with pi-cc-extensions: this package listed **after**
  it in `packages` so the header/editor win the shared slots.

## 1.3.0

- **Tool rows on their own switch — compatible with pi-cc-extensions** —
  new `/claude-tools on|off` command plus a `CC_TUI_TOOL_ROWS=0` env opt-out.
  The CC `⏺ Tool(args)` + `⎿ output` rows (7 built-ins + third-party
  fallback) can now be turned off independently so another TUI suite such as
  [minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)
  owns tool rendering, while the header / editor / spinner / status line /
  footer stay on. Off at runtime re-registers the stock native tools
  immediately; `/reload` hands rendering fully to the other extension.
  Default is on, so existing setups look exactly the same.

## 1.2.2

- **`⏺` dot states (CC fidelity)** — orange while running, green on success
  (`success` theme color), red on error. pi rebuilds the call row when the
  result lands, so the dot flips via `isPartial` with no extra subscription.

## 1.2.1

- **Native footer toggle** — new `/claude-footer` command (`on` / `off`, no-arg flips).
  `on` restores pi's built-in footer so other extensions' footers survive
  (MCP adapters, pi-lens, …) while the CC status widget above the prompt
  hides itself to avoid duplicating model/context/cost. `off` (default)
  keeps the CC-clean look: mode/hints render in the footer slot and the
  status widget stays visible.
- **Stale-ctx crash fix** — after session replacement or reload, the captured
  extension ctx goes stale and any `ctx.ui` / `ctx.model` / `ctx.sessionManager`
  access inside `render()` threw an uncaught exception that killed pi.
  Third-party tool rows now use the live theme pi passes to the render
  factories (no captured ctx); the status widget falls back to last-good
  usage numbers; the editor cursor callback and the spinner tick timer no
  longer touch ctx.
- **`❯` alignment (CC fidelity)** — the prompt triangle always sits at
  column 0 in both the input and history bars; continuation lines indent
  2 columns so no glyph ever shares the triangle's column (pi's editor
  used to drop the padding on soft-wrapped rows).
- **Footer auto-compact** — while the input holds text, the footer shows
  only the mode label (`⏵⏵ auto mode on …`); the keybinding hints return
  when the input is empty or submitted.

## 1.2.0

- Collapsed tool output capped at 3 physical rows; CC-style fallback rows
  for MCP / third-party tools without their own renderers.

## 1.1.0

- CC-verbatim mode banner (`⏵⏵ auto` / `⏸ plan`); 3-line collapsed output.

## 1.0.0

- Initial release: Clawd header, slim prompt bar, CC tool rows, spinner
  verbs, status line, history bars, claude-code theme.
