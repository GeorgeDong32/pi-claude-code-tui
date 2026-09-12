# Changelog

## 1.4.2 (Unreleased)

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
