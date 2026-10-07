# AGENTS.md — Repository Guide for AI Assistants

For AI coding agents (and human newcomers) working in this repository. This one file tells you what the code looks like, how to verify changes, and which pitfalls have already been hit.

> Architecture and module details live in [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) (Chinese version: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). 中文版本：[AGENTS.md](AGENTS.md).

## What this repository is

`@georgedong32/pi-claude-code-tui` — a [pi](https://pi.dev) package that restyles pi's TUI to look and feel like Claude Code: CC-style tool rows, startup header, rotating spinner verbs, configurable statusline, custom editor, and the `claude-code` theme.

**One red line**: this package is display-layer only. It **never changes any tool's `execute`, and never changes anything sent to the model**. Tool row takeover only swaps `renderCall` / `renderResult`; execution is always delegated to pi's built-ins. Any change that affects semantics (not just looks) drifts away from this package's purpose.

## Common commands

```bash
npm test            # node --test test/*.test.ts — no build step, TS runs directly (type stripping)
npm run typecheck   # tsc --noEmit
node scripts/bench-statusline.mjs   # statusline default-script benchmark (run after statusline changes)
```

There is no build step and no lint config. A green `npm test` + `npm run typecheck` is the baseline for every commit.

## Repository layout

```
extensions/
  claude-code-tui.ts        # Extension entry (default-export factory): event wiring, commands, mode switches
  lib/                      # Pure modules (no pi runtime dependency, unit-testable)
    cc-rows.ts              #   CC tool-row renderers (call/result rows, diffs, collapse, component memo, gutter-wrap)
    cc-compaction-row.ts    #   Compaction-row prototype patch + native indicator silencing
    cc-skill-row.ts         #   Skill-row prototype patch (CC-style ⏺ Skill(name), click-to-expand kept)
    cc-subagent-rows.ts     #   CC-style fleet/async roster drawing (drawCcFleetFrame / drawCcAsyncFrame, pure)
    subagent-presentation.ts #  SubagentPresentationBridge: probe/register/withdraw bridge over pi-subagents' presentation seam
    pi-proto-adapter.ts     #   PrototypeMethodAdapter: centralized prototype-patch lifecycle (ownership restore / getter refresh / shape degrade)
    obs-savings.ts          #   OBS-09 consumer: per-site observation-pack savings → callback (pseudo tool row via appendEntry; deduped, never throws)
    cc-markdown.ts          #   Markdown transformers: assistant white paint + user grey bar (pure)
    cc-status-line.ts       #   cc-status row: right group (model·effort │ Ctx │ cost), left/right join, footer mode chip
    takeover-rules.ts       #   Tool-row takeover matrix + resolver planner (pure fn, exhaustive table tests; BUILTIN_SEVEN single source)
    run-state.ts            #   Run/compaction state machine (injected clock/timer, tested transitions)
    host-status.ts          #   Host volatile-state read seam (effort level, never throws)
    claude-tui-editor.ts    #   CC-style editor (half-open rounded borders, ❯ prompt, bar cursor)
    pi-startup-header.ts    #   Pi-look startup header (animated logo + tips sidebar + header layout/tips pure fns)
    format.ts               #   Pure value formatters (durations/tokens/cost/model labels/completion line)
    spinner-verbs.ts        #   Spinner verb table (187 CC-aligned words + weighted sampling + Piing egg)
    spinner-shimmer.ts      #   Spinner verb shimmer (CC computeShimmerSegments port, pure)
    statusline.ts           #   Statusline JSON synthesis, badge, child-process runner, footer composition
    statusline-default-script.ts  # TS inline copy of the bundled default script (byte-synced with scripts/)
    status-snapshot.ts      #   UsageTracker: session usage snapshot (recomputed per event, cached per frame)
    core-bus.ts             #   core-bus client (P0-2): single subscription owner for three channels — ownership presence / handoff baselines / bus-change detection / generation; footer channel cache
    replica-session.ts      #   ReplicaSession (P2-1): the lifecycle controller — mutable state / enable-stop order / generation / render delegates / command state; the entry only wires
    tool-summary.ts         #   schema-driven generic tool-arg summaries (P1-1 R2: preferred fields + required string)
    pm-capability.ts        #   permission-modes status consumer (pure read chain, never subscribes) + core notification tail-queue adapter
    prefs.ts                #   ~/.pi/agent/claude-tui.json read-modify-write (atomic)
themes/claude-code.json     # claude-code theme (vars/colors)
scripts/statusline-default.sh   # Default statusline script (source of truth, byte-synced with the TS inline copy)
scripts/bench-statusline.mjs    # Statusline performance benchmark
test/                       # node --test; golden tests + pure-module unit tests
docs/                       # Architecture doc, manual verification checklist, archived design docs
src/                        # Empty leftover directories (no files — do not reference)
```

## Code conventions

- **TypeScript ESM, executed directly**: pi loads TS via jiti; there is no build artifact. Relative imports **must carry the `.ts` extension** (e.g. `./lib/prefs.ts`).
- **Tabs for indentation** (consistent with the existing code).
- **Pure modules first**: anything testable without the pi runtime (renderers, formatters, JSON synthesis, prefs IO) goes in `lib/` with injectable dependencies (duck-typed theme, injected RNG/path). The entry file only wires things up.
- **Byte-stable renderers**: output of `lib/cc-rows.ts` is pinned byte-for-byte by `test/cc-rows.golden.test.ts`. Changing rendered output requires explicitly updating the golden files and explaining the visual diff in the commit message.
- **Duck-typed mirrors of pi internals**: do not import types pi doesn't export; follow this repo's convention of `XxxLike` mirror interfaces + version gating in `lib/` (see `pm-capability.ts`).
- Dependency versions: devDependencies are pinned to the current pi version (`1.0.x`); the peerDependency is `>=1.0.1` (tool rows need `pi.registerToolRenderer`, added in 1.0.1). Adaptation work for pi upgrades gets a scope like `1.0-adapt`.

## Commits & releases

- Conventional Commits: `feat(rows): …`, `fix(status): …`, `chore(release): 1.5.0`. Common scopes: `rows`, `tui`, `status`, `statusline`, `1.0-adapt`.
- Release flow (git-first): bump the `package.json` version → update `CHANGELOG.md` → `chore(release): vX.Y.Z` → `git tag vX.Y.Z` → push. The local install is pi's git-install form (`git:github.com/GeorgeDong32/pi-claude-code-tui`) — `git pull` in the install dir + `/reload` picks it up, so **npm publish is not a required step** (the README's install guide is `pi install git:…` too; if an npm release is wanted, this machine has no official-registry credentials — the user must `npm login` and publish personally). `package-lock.json` and `AGENTS.md` used to be gitignored; AGENTS.md is now tracked.

## Pitfalls when writing / modifying the extension

These are not style advice — they are **real constraints that crash pi or regress behavior**:

1. **Never throw inside `render()` / `updateDisplay()`**. Render callbacks run on call stacks pi cannot catch; a throw kills pi entirely. Degrade silently on every failure path (unreadable prefs, failing script, missing theme).
2. **No spawning or full rescans on the render hot path**. Per-frame render only reads caches: session usage comes from `UsageTracker` (recomputed once per `message_end`), the statusline is event-driven + 250 ms debounce + in-flight coalescing, and each frame at most detects a width change.
3. **`ctx` / `ctx.ui.theme` go stale**. Session replacement or `/reload` invalidates old contexts. Never capture the theme in a long-lived closure at enable time; read it per frame from the current ctx, or pass a lazy `getFg()` accessor like `cc-compaction-row.ts` does. The startup header (`pi-startup-header.ts`) is no exception: its render reads only entry-injected getters and the theme parameter of the `setHeader` factory — never ctx.
4. **Prototype patches must be idempotent**. Guard with markers like `__ccCompact`. jiti's `moduleCache: false` can produce multiple module instances of the same class; a deep-path import may patch an instance nobody uses (that's why the compaction indicator is silenced via an instance-level render override + component-tree search instead). The remaining patches are the compaction row / skill row / user message bar — tool rows moved to the official `pi.registerToolRenderer` channel (since 1.8.0) and no longer rely on patching.
5. **Tool rows go through the official renderer channel (pi >= 1.0.1)**: the `pi.registerToolRenderer` resolver can only be registered while loading and is consulted per component construction; yielding must return `next()` verbatim (swallowing it strips builtin/other renderers). The header and editor remain single-occupancy last-writer-wins slots. The coexistence strategy with other TUI extensions is auto-yield (`pi.getAllTools()` source-metadata probing — `next()` cannot distinguish builtin renderers from other extensions' registered ones) + `/claude-tools on` force takeover + `FORCE_RESULT_EXEMPT` (live cards such as pi-subagents' are never collapsed).
6. **Never assume load order**. This package may load before OR after core / other extensions (both orders occur in real settings), so enable-time probing can miss later loaders. Every probe needs a retry. Subscriptions all go through `lib/core-bus.ts` (ownership-tagged presence, handoff baselines, bus-change detection, generation-invalidated late callbacks); retry points are session_start and the cc-status / cc-footer renders (O(1) fast path). `readPmStatus()` stays a pure read and never subscribes.
7. **No filesystem anchor at runtime**. jiti evaluates extension files from data: URLs, so `import.meta.url` never points at the installed package. Anything needing file content (the default statusline script) must be inlined as a TS string and kept **byte-identical** with `scripts/statusline-default.sh` (`test/statusline.test.ts` enforces it) — change both together or watch the sync test go red.
8. **`keyText()` returns `""` outside a host session (i.e. in tests)**. Every expand hint needs a literal fallback (e.g. `"ctrl+o"`).
9. **Prefs are a shared file**: `~/.pi/agent/claude-tui.json` holds both `toolRows` and `statusLine`. All writes go through `savePrefs()`'s read-modify-write + tmp/rename atomic swap — never overwrite the whole file (the keys historically clobbered each other).
10. **Raw ANSI handling**: use `visibleWidth` / `truncateToWidth` from pi-tui for width math; if you roll your own ANSI-stripping regex, remember APC sequences (the second replace in `stripAnsi`).
11. **All timers need `unref()`**; the blink timer only toggles while the editor is focused, and `requestRender()` calls are non-forced (preserving pi's line-diff cache).
12. **Environment switches**: `CC_TUI_TOOL_ROWS=0` (force tool rows off), `PERMISSION_MODES_INHERITED_MODE` (legacy mode-channel fallback), and `OVERRIDE_TERM_WIDTH` inside the statusline child-process env. Do not repurpose these names.

## Documentation map

| Document | Contents |
| --- | --- |
| [README.md](README.md) | User manual: install, commands, compatibility, troubleshooting |
| [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) | Architecture: module map, data flow, rendering takeover, statusline protocol |
| [docs/manual-verification.md](docs/manual-verification.md) | Manual visual verification checklist (render behavior automated tests can't see) |
| [docs/STATUSLINE-PLAN.md](docs/STATUSLINE-PLAN.md) | Historical statusline design doc (SL1–SL5 all shipped; archived) |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## Known repo-hygiene issues

- `src/` contains only empty directories and zero files — historical leftovers. Do not put code there and do not import from it.
