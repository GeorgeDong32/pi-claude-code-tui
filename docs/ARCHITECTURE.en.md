# ARCHITECTURE — pi-claude-code-tui

This document describes the internal architecture of `@georgedong32/pi-claude-code-tui`: module breakdown, data flow, rendering takeover mechanisms, the statusline child-process protocol, preference persistence, and the integration points with the pi host. It is aimed at contributors changing the code; the user manual lives in [README](../README.md).

> 中文版本：[ARCHITECTURE.md](ARCHITECTURE.md)。Repository conventions and pitfalls: [../AGENTS.en.md](../AGENTS.en.md).

## 1. Overview

This package is a pi extension + theme that runs entirely inside pi's TUI process and **touches only the display layer**: rendering takeover happens through pi's public extension API (tool rows via the official `pi.registerToolRenderer` renderer channel, `ctx.ui.setHeader/setEditorComponent/setWidget`, `registerMarkdownTransformer`) plus a small number of prototype patches (compaction row / skill row / user message bar). Tool `execute` and everything sent to the model are never modified.

```
package.json ("pi": { extensions, themes })
        │ loaded by jiti (data: URLs, moduleCache: false)
        ▼
extensions/claude-code-tui.ts   ← entry factory: event wiring / commands / mode switches
        │ calls
        ▼
extensions/lib/*                ← pure modules: renderers, protocol, IO, utilities
themes/claude-code.json         ← theme (pi theme system)
```

## 2. Module map

| Module | Responsibility | Key exports | Tests |
| --- | --- | --- | --- |
| `extensions/claude-code-tui.ts` | Entry. `export default function (pi)`; registers commands, subscribes to session events, mounts/unmounts every rendering slot | extension factory | (wiring layer; covered by lib unit tests + manual verification) |
| `lib/cc-rows.ts` | CC tool rows: `⏺ Tool(args)` call row + `⎿` output gutter, colored diffs, collapse (3 physical-line cap), component memo, gutter-wrap layout, the args-summary table | `ccCall`, `ccResult`, `callArgsFor`, `renderMemoizedResult`, `gutterWrapRows` | `cc-rows.golden.test.ts` (byte-exact golden + memo/layout table tests) |
| `lib/takeover-rules.ts` | Tool-row takeover decision matrix (user switches × MCP × builtin-seven × force × exemptions, call/result slots + shell derivation) and the resolver planner `planResolverTakeover`; single home of BUILTIN_SEVEN / FORCE_RESULT_EXEMPT | `decideTakeover` / `planResolverTakeover` | `takeover-rules.test.ts` (exhaustive boolean matrix + planner table) |
| `lib/cc-markdown.ts` | Markdown transformers: assistant white paint (fence tracking, list-marker preservation), user grey bar (NBSP padding math) | `assistantWhiteText`, `userMessageBar` | `cc-markdown.test.ts` |
| `lib/cc-status-line.ts` | cc-status row: right group (model·effort │ Ctx p% │ cost with pct clamping/omission rules), the left/right three-branch join, footer mode chip (MODE_META projection) | `buildStatusRightGroup`, `statusRowLayout`, `permissionModeLabel` | `cc-status-line.test.ts` |
| `lib/run-state.ts` | Run/compaction state machine: single tick owner, verb sampled once per run, ≥1s completion gate, quiet stop on stale ctx | `RunStateMachine` | `run-state.test.ts` (event sequences on an injected clock/timer) |
| `lib/host-status.ts` | Host volatile-state read seam (effort/thinking level, never throws — render-stack safety) | `readEffortLevel` | `host-status.test.ts` |
| `lib/cc-compaction-row.ts` | Patches the native `[compaction]` box into a CC-style row; silences the native "Compacting…" indicator inside the component tree | `patchCompactionRow`, `silenceNativeCompactionIndicator` | `cc-compaction-row.test.ts` |
| `lib/cc-skill-row.ts` | Patches the native `[skill]` box into the CC-style `⏺ Skill(name)` row; the expanded body reuses cc-rows' gutter-wrap (byte-pinned), native click-to-expand kept | `patchSkillRow` | `cc-skill-row.test.ts` (incl. byte-level expansion assertions) |
| `lib/claude-tui-editor.ts` | CC-style editor: flat rules, gold `❯`, themed bar cursor (530 ms blink, focused only), autocomplete lifted above the box | `CodexStyleEditor`, `stripAnsi`, … | (visual behavior via manual verification) |
| `lib/pi-startup-header.ts` | Pi-look startup header: 13-frame animated logo, "Let's build something great", model/effort/cwd, tips sidebar; the header layout-width and tips-picking pure functions live here (their only consumer) | `PiStartupHeader`, `headerColumnWidths`, `pickSlashCommandTips` | `pi-startup-header.test.ts` (layout/tips table tests) |
| `lib/statusline.ts` | CC-compatible statusline: JSON synthesis, badge math, one-shot child-process runner, footer composition | `buildStatuslineJson`, `composeFooterLines`, `StatuslineRunner` | `statusline.test.ts` |
| `lib/statusline-default-script.ts` | TS inline copy of the bundled default script (no filesystem anchor at runtime, see §8) | `DEFAULT_STATUSLINE_SCRIPT` | `statusline.test.ts` (byte-sync with scripts/) |
| `lib/status-snapshot.ts` | `UsageTracker`: scans the branch once per `message_end`, caches used/cost/last/total usage | `UsageTracker` | `status-snapshot.test.ts` |
| `lib/replica-session.ts` | ReplicaSession (P2-1): the single home of the entry's hidden lifecycle controller — the mutable state, enable/disable/shutdown order, generation, render delegates (last-good truncation), command state changes; the entry keeps only load-time registration + event routing | `ReplicaSession`, `UiSlots` | `replica-session.test.ts` |
| `lib/core-bus.ts` | core-bus client (spec P0-2): the single subscription owner for three channels — notification tail queue, observation sites, display.footer — with ownership-tagged presence, handoff baselines (B3 cursor / B5 sites baseline), bus-instance-change detection (`instance` first, `onChange` closure identity fallback), and generation-invalidated late callbacks | `createCoreBusClient`, `createFooterChannel` | `core-bus.joint.test.ts` (real-core joint fixtures) |
| `lib/pm-capability.ts` | permission-modes status consumer (versioned capability channel → bus snapshot → legacy-key fallback chain, pure read, never subscribes) + the notification tail-queue adapter (B3 cursor diffing) | `readPmStatus`, `createNotificationAdapter` | `pm-capability.test.ts` |
| `lib/obs-savings.ts` | OBS-09-SITES adapter: per-site dedupe (full tuple key, session/branch domain, branch-scan rebuild); callback failures mark the batch attempted | `createObsAdapter`, `readObsSites` | `obs-savings.test.ts` |
| `lib/prefs.ts` | `~/.pi/agent/claude-tui.json` read-modify-write: merge + tmp/rename atomic swap; corrupt files fall back to `{}` | `loadPrefs`, `savePrefs` | `prefs.test.ts` |
| `lib/format.ts` | Pure value formatters: durations/tokens/cost, model/effort labels, the completion line | `formatDuration`, `formatTokens`, `formatCost`, `buildCompletionLine` | `format.test.ts` |
| `lib/spinner-verbs.ts` | Spinner verb table: 187 words byte-aligned with CC (Clauding→Piing), weighted sampling (staples ×3 / eggs ×0.25) | `weightedVerbSample`, `SPINNER_VERBS` | `spinner-verbs.test.ts` |
| `lib/spinner-shimmer.ts` | Spinner verb shimmer (CC computeShimmerSegments port) | `shimmerSegments`, `SPINNER_TICK_MS` | `spinner-shimmer.test.ts` |
| `themes/claude-code.json` | claude-code theme: `vars` (palette variables) + `colors` (pi semantic-color mapping) + `export` | — | — |
| `scripts/statusline-default.sh` | Default statusline script (source of truth) | — | byte-sync pinned by `statusline.test.ts` |
| `scripts/bench-statusline.mjs` | Default-script performance benchmark (p50 ≈ 30 ms; bash fork floor ~25 ms) | — | — |

Dependency direction: entry → lib, one-way; a few pure-function reuses between libs (`cc-skill-row` → `cc-rows` gutter-wrap, `cc-status-line` → `format`, `pi-startup-header` → `format`/`host-status`), all pure and acyclic. Libs never import pi runtime state — only pure functions (`visibleWidth` etc. from `pi-tui`) and a few pi-coding-agent exports (`keyText`, `renderDiff`, and the component classes being patched).

## 3. Lifecycle & event flow

The entry factory runs once at extension load, where the **renderer resolver is registered** (`pi.registerToolRenderer`, pi >= 1.0.1 — the loader only accepts it while loading). It reads closure gates per tool-call construction; the ownership probe still runs at `session_start` (`enable(ctx)`) — it needs every extension registered, and non-TUI modes keep stock rendering.

```
load (jiti)
  ├─ register commands: claude-tui / claude-tools / claude-footer / claude-verb / claude-statusline (handlers only route into ReplicaSession)
  ├─ registerToolRenderer resolver (reads session.toolRowsDecisionInput(); see §4)
  ├─ registerEntryRenderer(cc-tui/observation-packed)
  └─ registerMarkdownTransformer (assistant plain lines forced white; user messages as CC full-width bars)

Lifecycle state and order live in lib/replica-session.ts (P2-1): every entry
event handler is a one-line `session.onXxx(ctx)` route; enable order = core-bus
activate (presence/handoff baseline) → model info → tool-row decision → bridge
start → patches → header → editor → footer mode → working → thinking tip →
statusline, with a full rollback when any step throws.

session_start → enable(ctx)
  ├─ tool-row mode decision (see §4)
  ├─ ctx.ui.setHeader(...)            ← startup header (tui mode)
  ├─ ctx.ui.setEditorComponent(...)   ← CC editor
  ├─ ctx.ui.setWidget("cc-status")    ← spinner / completion-line status widget
  ├─ ctx.ui.setWidget("cc-footer")    ← statusline + mode/hints rows
  ├─ patchCompactionRow(getFg)        ← CC-style compaction row
  ├─ patchSkillRow / applyUserBarPatch (the UserMessageComponent.rebuild patch is applied at enable, NOT at load)
  ├─ publishCcTuiCapability()         ← tell pm this package exists (mutual suppression)
  └─ coreBusClient.activate()  ← P0-2: handoff baseline + presence declaration + three-channel subscription (retry points: session_start / cc-status / cc-footer render)

Runtime events
  ├─ message_end / agent_start / agent_settled → UsageTracker.observe() → statusline refresh, cc-status update
  ├─ model_select → statusline refresh
  ├─ session_before_compact → silence native indicator, cc-status mirrors compaction progress
  ├─ session_compact(_failed) → restore
  └─ session_shutdown / disable → setHeader/setEditorComponent/setWidget(undefined), withdraw capability
```

`/claude-tui` is the master switch (header/editor/animation/status widget; tool rows are independent), while `/claude-tools`, `/claude-footer`, and `/claude-statusline` control the three subsystems and persist their choices to prefs.

## 4. Rendering takeover (the core)

### 4.1 Tool rows: the official renderer channel (pi >= 1.0.1, `pi.registerToolRenderer`)

All tool rows (builtin seven / third-party / MCP) are taken over by a **single resolver** (spec: `specs/design/2026-10-03-pi-1.0-tool-renderer-migration`). pi consults it on every `ToolExecutionComponent` construction (streaming / execution start / transcript rebuild), with `next()` returning what the remaining resolvers, the registered tool definition, and pi's builtin renderer table would use. The resolver decides via `planResolverTakeover` (`lib/takeover-rules.ts`) and **merges per slot**: taken-over slots get CC renderers, yielded slots keep `next()`'s value verbatim, and `renderShell` derives from the call decision (takeover → `"self"` flat; a yielding third-party tool also keeps the flat shell). Only renderers are swapped — `execute` and parameters are never touched.

The decision matrix (single home, exhaustively table-tested): user switches gate everything; official MCP tools are always taken over (the CC row is the user-asked shape); the builtin seven (`BUILTIN_SEVEN`, **without powershell** — pi's builtin renderer-table eighth key, which stays stock) are ours whenever rows are on; third-party tools that ship renderers auto-yield (another TUI extension may own the visuals) and are taken over in `/claude-tools on` force mode; renderer-less third-party tools are always taken over; `FORCE_RESULT_EXEMPT` (the subagent live card / obs_recall paged view) exempts the result slot in force mode.

Memoization (plan A6): one resolver call corresponds to exactly one component construction (pi resolves per construction, uncached), so a closure-local `newResultMemoSlot()` is a per-component memo; `renderResult` is invoked every frame and reuses the component and its wrap cache. The collapse cap is **3 physical lines** (counted after terminal wrapping).

The pre-1.0 mechanisms (re-registering the builtin seven via `pi.registerTool` + the `ToolExecutionComponent` prototype patch) were removed in 1.8.0. Ownership probing still happens at `session_start` via `pi.getAllTools()` source metadata (`externalToolOwner`, name set imported from `BUILTIN_SEVEN`) — the resolver's `next()` cannot distinguish pi's builtin renderers from another extension's registered ones; extensions that register tools in a later `session_start` (e.g. SoL-Pi) are invisible to the probe, so the README recommends `/claude-tools on` when co-running them. On pi < 1.0.1 the extension loads but tool rows stay stock with a console.warn (git installs don't enforce peerDependencies).

Three modes: `auto` (default), `on` (full takeover), `off` (yield). The switches affect **newly appearing tool rows only** (the resolver is consulted per construction); already-rendered rows keep their renderers. `off`/`auto-off` yield immediately and no longer clobber other extensions' registrations.

### 4.2 Other rendering patches

- **Compaction row**: `CompactionSummaryMessageComponent.prototype.updateDisplay` becomes one `⏺ Context compacted from N tokens` line with the summary expanding under the `⎿` gutter; Box background/padding are stripped so the row sits flush in the transcript.
- **Native compaction indicator silencing**: the class is not exported, so the TUI component tree is searched for a `CompactionStatusIndicator` instance whose `render` is overridden to zero rows (instance-level override; pi clears the indicator itself when compaction ends).
- **User message bars**: a `UserMessageComponent.prototype.rebuild` patch zeroes child `paddingY` (compact bar); a markdown transformer renders user messages as a `❯ `-prefixed, rgb(55,55,55) full-width bar (padded with NBSPs) and forces assistant plain lines white while markdown-structured lines keep their theme colors.

## 5. Statusline child-process protocol

Modeled on Claude Code's statusline contract: the extension synthesizes **CC-shaped JSON** (`model` / `workspace` / `context_window`, plus this package's extension fields `pi.cost_usd` and `pi.effort`) and feeds it to the user command's stdin; stdout (ANSI included) renders line-by-line below the editor — script rows on top, the mode/hints row below (one `cc-footer` widget, so ordering is free). A user's `~/.claude/statusline-command.sh` is reused without modification.

`StatuslineRunner` scheduling discipline (the render path never spawns):

- **Event-driven**: refreshes only on `message_end` / model switch / compaction / terminal width change / config change;
- **250 ms debounce** for bursts; **in-flight coalescing** (an identical mid-flight request is dropped; a changed one sets `pendingAfterInFlight` and re-runs after landing);
- **2 s timeout**; output capped at **4 lines / 64 KB**;
- **3 consecutive failures** degrade to one grey hint line, self-healing on the next success;
- the child env gets `OVERRIDE_TERM_WIDTH`; the script drops segments right-to-left when narrow.

`composeFooterLines` assembles statusline rows (optional) + the effort badge (`appendBadge`, right-aligned chip) + the untouched cc-footer mode/hints rows; `/claude-footer on` hides the whole CC status widget and restores pi's native footer (keeping other extensions' footers such as MCP adapters).

## 6. Preference persistence

All switches live in `~/.pi/agent/claude-tui.json` (path respects `PI_CODING_AGENT_DIR`):

```json
{ "toolRows": true, "statusLine": { "enabled": true, "command": "", "badge": true } }
```

Writes go through `savePrefs`: read disk → spread → merge → write tmp → rename. An `undefined` value deletes its key (`/claude-tools auto` returns to auto-detect). `toolRows` and `statusLine` historically clobbered each other — that is the direct motivation for the pure-module + atomic-write refactor (SL2). `CC_TUI_TOOL_ROWS=0` is an environment-level force-off (overriding prefs).

## 7. Integration with other extensions

- **permission-modes (pm)**: `Shift+Tab` is intercepted in the editor's `handleInput` (ahead of pi's built-in thinking cycle) to toggle Plan/Auto. pm status is read through `readPmStatus`'s three-level fallback chain: core bus snapshot `__piClaudeCodeCore.modes` (primary) → versioned `__piPermissionModes` capability object → legacy `__pmWorkingStats` string + the `PERMISSION_MODES_INHERITED_MODE` env var. Mode icons/labels come from pm's published `meta` (single-sourced from core's MODE_META).
- **Notification display (P0-2, unified subscription in `lib/core-bus.ts`)**: the presence declaration is the ownership handoff point — this package declares `notificationsConsumer: true`, so core stops its direct forward and its fallback only advances the cursor. Cursor start (B3): attaching to the SAME bus instance the presence was declared on continues from the queue's max id at declaration (history the fallback already showed is not replayed); a bus change (reload / late load) starts from 0 (the new bus's queue was never displayed — our live presence suppressed both paths). Attach consumes the CURRENT snapshot immediately (onChange does not replay; the handoff window is not lost); shutdown/close withdraws the presence (B4) — between shutdown and the next session_start core's fallback displays by itself, nothing is lost. BOTH load orders work; bus replacement is detected via `snapshot.instance` (core P1-1+) or the `onChange` closure identity (old cores — one bus reuses one register closure). Limits kept honest: the tail queue is capped at 20 with no ACK — items pushed out before attach are not recoverable.
- **Core footer rows (B6)**: `display.footer` rows published by core's economy modules on degradation (e.g. the observation-pack compat note) render as independent dim rows AFTER the statusline script rows and BEFORE the hints line; a missing field or a bus change clears the cache. `/claude-tui off` restores the host's stock footer and does NOT hand the slot back to core (core only installs its modes footer at session_start; after off the downgrade rows have no renderer until an extension footer is actually installed — core's load-time console.warn remains).
- **pi-subagents**: force mode has dedicated adaptations (call row = agent type + task summary, zero redundant running rows, live cards exempt from collapse), see §4.1 and the README.
- **Slot coexistence**: header/editor slots are last-writer-wins; when co-running other TUI suites, put this package later in the packages list.

## 8. Runtime constraints (why the code looks like this)

- **jiti `moduleCache: false` + data: URLs**: `import.meta.url` never points at the installed package → anything needing packaged files must be inlined (the default statusline script therefore exists as a TS string, byte-synced with `scripts/statusline-default.sh` and enforced by `statusline.test.ts`); the same component class can appear as multiple module instances → deep-path import patches are unreliable; prefer pi-exported classes + idempotent markers.
- **Render callbacks must not throw**: `render()` runs on stacks pi cannot catch. Every failure path (missing jq, failing script, corrupt prefs, missing theme) degrades silently.
- **Per-frame cost**: render only reads caches (UsageTracker snapshot, runner's completed rows); width change is the only per-frame check. The blink timer toggles only while focused; all timers are `unref()`ed; `requestRender` calls are non-forced to preserve pi's line-diff cache.
- **Context staleness**: a `session_start` ctx goes stale after session replacement → the theme is read lazily/per frame; the accent ANSI sequence is cached once as a string at enable time (`setEditorAccentOpen`).

## 9. Theme

`themes/claude-code.json` follows the pi theme schema: `vars` defines the Claude dark palette (accent = sage `#8ABEB7`, userMsgBg, diff color pairs, …), and `colors` maps pi's semantic colors (accent/border/toolOutput/mdHeading/…) onto the vars. The editor cursor and autocomplete derive their ANSI sequences from the theme accent (fg→bg conversion), so the cursor follows the accent if the theme changes.

## 10. Testing architecture

- **Pure-module unit tests** (`node --test`, TS via type stripping): prefs atomicity, UsageTracker semantics (used = last assistant message's cumulative usage; cost = the sum), statusline JSON shape and badge math, the pm fallback chain + lifecycle pairing, format formatters, header layout/tips, markdown transformers, the cc-status row's three branches, the exhaustive takeover matrix, run-state event sequences, memo/gutter-wrap reuse.
- **Golden render tests**: `cc-rows.golden.test.ts` pins rendered bytes and color routing with identity/recording themes — the equivalence net for the A6 wrap-cache and future render changes. `keyText()` returns `""` without a host, so tests assert literal fallbacks.
- **Byte-sync test**: `DEFAULT_STATUSLINE_SCRIPT` ↔ `scripts/statusline-default.sh`.
- **Manual verification**: `docs/manual-verification.md` covers the visual behavior automated tests cannot see (spinner frame advance, cursor blink, resize artifacts, statusline debounce regressions, …).

## 11. Historical design docs

`docs/STATUSLINE-PLAN.md` records the full design process of the statusline subsystem (SL1–SL5: rev1→rev3, user decisions D0–D5, performance gate). Everything in it has shipped; it is kept for decision history only — current behavior is defined by this document and the code.
