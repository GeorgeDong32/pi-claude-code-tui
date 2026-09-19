# Changelog

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
