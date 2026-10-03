# pi-claude-code-tui

**Claude Code's terminal look, with Pi's models and tools.**

A UI extension and dark theme for the [Pi coding agent](https://pi.dev). Get compact tool output, colorful diffs, a cleaner editor, animated working indicators, and a configurable statusline—with an animated Pi startup header.

This package changes presentation only. Tool execution, permissions, and content sent to the model stay under Pi and your other extensions' control. It works with the models you already use in Pi; Claude is not required.

<img width="691" height="448" alt="Claude Code-style conversation, tool output, editor, and status display in Pi" src="https://github.com/user-attachments/assets/3a030401-ed14-4705-b865-fdaf35fcba4f" />

*Earlier version shown. The current startup header uses an animated Pi logo.*

[Installation](#installation) · [Features](#features) · [Commands](#commands) · [Statusline](#statusline) · [Compatibility](#compatibility) · [Troubleshooting](#troubleshooting)

## Installation

Install with Pi's package manager:

```sh
pi install git:github.com/GeorgeDong32/pi-claude-code-tui
```

Start Pi, open `/settings`, select the **claude-code** theme, and restart Pi. The UI is enabled automatically in interactive sessions.

### Requirements

- Pi: declared peer support is `@earendil-works/pi-coding-agent >=1.0.1` (tool rows render through the official `pi.registerToolRenderer` channel, added in 1.0.1); development and tests currently target **1.0.1**. On older pi the extension loads but tool rows stay stock with a console warning. Some visual features depend on Pi internals and may need adaptation on other versions.
- A dark terminal with Unicode support. True color gives the best match to the bundled palette.
- **Bash and jq** for the optional bundled statusline script. They are not needed for the main UI.

## Features

### Compact, readable tool output

Tool calls use Claude Code-style `⏺ Tool(args)` rows, with results under a muted `⎿` gutter. Long output collapses to **three terminal rows after wrapping**, keeping large JSON responses and command output from filling the conversation. Press `Ctrl+O` to expand tool output.

- Styles Pi's built-in `read`, `bash`, `grep`, `find`, `ls`, `write`, and `edit` tools.
- Shows colored edit diffs, clear error indicators, and blinking call dots while tools run.
- Gives third-party tools without custom renderers the same compact layout.
- Displays MCP calls as `server - tool (MCP)`.
- Renders skill invocations as `⏺ Skill(name)`, preserving click-to-expand.
- Shows context compaction as `⏺ Context compacted from N tokens`, with an expandable summary.

### A consistent conversation and editor

- **Pi startup header:** animated pixel logo, model and effort level, working directory, and tips drawn from available commands.
- **Editor:** minimal borders, an accent-colored `❯` prompt, a blinking bar cursor, and suggestions when the input is empty.
- **Messages:** full-width gray user-message bars and white assistant text, while preserving themed Markdown headings, quotes, and code.
- **Thinking:** a compact `✻ Thinking… (ctrl+t to expand)` label when Pi's thinking blocks are hidden. Pi owns the collapse preference.
- **Theme:** a bundled `claude-code` dark palette for the whole terminal UI.

### Working indicators and session information

Each run gets one of 187 playful spinner verbs, such as `Pondering…` or `Vibing…`, with an animated shimmer. The verb stays fixed for the run; `/claude-verb` rerolls it. Completed runs show elapsed time and a finish timestamp.

The default status display shows the model, thinking effort, context usage, and session cost. You can keep Pi's native footer or enable a script-based statusline below the editor. Keyboard hints collapse while you type.

## Commands

Run these inside Pi:

| Command | What it does |
| --- | --- |
| `/claude-tui` | Toggle the header, editor, working indicator, and status UI. Tool rows have their own control; turning this off also restores stock tool rows. |
| `/claude-tools auto` | Use automatic tool-row ownership detection; yield when another extension owns the built-in rows. **Default.** |
| `/claude-tools on` | Force Claude Code-style call/result rendering, including tools with custom renderers, with the live-result exceptions below. |
| `/claude-tools off` | Disable this package's tool-row overrides. |
| `/claude-footer [on\|off]` | `on` restores Pi's native footer and hides the default CC status widget; `off` uses the compact layout. No argument toggles. |
| `/claude-verb` | Reroll the working verb. |
| `/claude-statusline [on\|off]` | Enable or disable the script-based statusline. No argument toggles. **Off by default.** |
| `/claude-statusline set <command>` | Set a custom statusline command and enable it. |
| `/claude-statusline badge on\|off` | Show or hide the right-aligned effort badge. **On by default.** |

Tool-row and statusline preferences persist across `/reload` and restarts in `~/.pi/agent/claude-tui.json`. The main UI and native-footer toggles are session controls.

### Permission modes

When a companion extension such as `pi-claude-code-core` or `pi-permission-modes` publishes permission state, the footer displays its current mode and working statistics. Mode switching, `/mode`, and any `Shift+Tab` binding belong to that companion extension.

This package does not implement Plan Mode or change which tools are allowed. Without a mode provider, Pi's existing permissions and keybindings apply.

## Recommended Pi settings

For a layout closer to Claude Code, merge these settings into `~/.pi/agent/settings.json` and restart Pi:

```json
{
  "theme": "claude-code",
  "tuiMode": "fullscreen",
  "outputPad": 0,
  "quietStartup": true,
  "hideThinkingBlock": true
}
```

| Setting | Effect |
| --- | --- |
| `tuiMode: "fullscreen"` | Keep the editor near the terminal bottom with a scrollable conversation. |
| `outputPad: 0` | Align conversation output with the left edge. |
| `quietStartup: true` | Hide Pi's resource listing while keeping the custom header. |
| `hideThinkingBlock: true` | Collapse thinking into a single line; `Ctrl+T` toggles it in-session. |

These are Pi settings, separate from this extension's preferences. Availability depends on your Pi version.

## Statusline

The optional statusline runs a shell command with session JSON on stdin and displays its stdout below the editor, preserving ANSI colors.

### Use the bundled script

With Bash and jq installed, run:

```text
/claude-statusline on
```

The default script shows the directory, Git branch and dirty-file count, model, context usage, and cost. It drops segments as terminal width decreases.

```text
~/project │ ◆main ±2 │ model │ Ctx 23% (46k/200k) │ $0.042
```

When enabled, the script replaces the model/context/cost section of the default status display to avoid duplication. An optional effort badge appears at the right when space allows. Its `/effort` hint refers to the companion core extension's command.

### Use your own script

Point the extension at a command—for example, an existing Claude Code statusline script:

```text
/claude-statusline set ~/.claude/statusline-command.sh
```

The input provides these Claude Code-shaped fields:

| Object | Fields |
| --- | --- |
| `model` | `display_name`, `id` |
| `workspace` | `current_dir`, `project_dir` |
| `context_window` | `context_window_size`, `current_usage.input_tokens`, `current_usage.output_tokens`, `total_input_tokens`, `total_output_tokens`, `used_percentage`, `remaining_percentage` |
| `pi` | `cost_usd`, `effort`, `provider` |

Scripts that use these fields can be reused; scripts expecting other Claude Code fields need adjustment. For a minimal custom script:

```sh
#!/usr/bin/env bash
jq -r '"\(.model.display_name) │ Context \(.context_window.used_percentage)%"'
```

Save it as `~/pi-statusline.sh`, then run `/claude-statusline set bash ~/pi-statusline.sh`.

Refreshes happen asynchronously on session events, model changes, compaction, terminal resizing, and configuration changes. Commands have a two-second timeout and output is limited to four lines. After three consecutive failures, a muted error appears; a later successful run clears it.

## Compatibility

### Other TUI extensions

Pi's tool-renderer, header, editor, and footer slots can have competing owners. In the default `auto` mode, this package checks tool ownership at session start and yields to detected overrides of the built-in tools.

- Use `/claude-tools on` to give this package control of tool rendering, or `/claude-tools off` to let another extension handle it. Switches apply to newly appearing tool rows immediately (already-rendered rows keep their renderers).
- Put this package **after other TUI packages** in your settings' `packages` list if you want its header and editor to win.
- Use `/claude-footer on` when you want Pi's native footer, including status information from other extensions.
- Set `CC_TUI_TOOL_ROWS=0` before launching Pi to disable tool rows through the environment.

Tool-row overrides replace presentation only; the owning tool's execution and parameters stay intact. Print and RPC sessions keep their stock rendering.

### Subagents and SoL-Pi

In forced tool-row mode, `subagent` calls get concise agent/task summaries while their custom live result cards stay intact, preserving progress, token counts, and checklists.

For SoL-Pi, `/claude-tools on` can unify rows even when its tools register after startup detection. `obs_recall` gets a short call summary while its dense paged result view is preserved. Fused `write`/`edit` calls retain a visible `then_run` badge. These integrations do not alter Action Fusion or Observation Pack execution.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Header or editor is missing | Move this package after other TUI extensions in `packages`, then `/reload` or restart. Check the other extension's own header/editor settings. |
| Tool rows use another style | `auto` may have yielded to another owner. Run `/claude-tools on` to override it. |
| Tool rows conflict with another extension | Run `/claude-tools off` — new tool calls render stock immediately; no `/reload` needed. |
| Another extension's footer information is missing | Run `/claude-footer on`. |
| Statusline says `jq required` | Install jq, or choose a custom command with its own dependencies. |
| Custom statusline fails or stays empty | Check that the command accepts JSON on stdin, writes display text to stdout, and finishes within two seconds. |
| An update does not appear | Update the installed package, then restart Pi. |

If the issue persists, [open an issue](https://github.com/GeorgeDong32/pi-claude-code-tui/issues) with your Pi version (`pi --version`), package version, terminal, package load order, and a screenshot or reproduction steps.

## Development

The package loads TypeScript directly; there is no build step.

```sh
npm install
npm test
npm run typecheck
```

When changing the statusline, also run `node scripts/bench-statusline.mjs`. Tool rendering is covered by byte-level golden tests; terminal behavior also needs visual verification.

- [Contributor guide](AGENTS.en.md) ([中文](AGENTS.md))
- [Architecture](docs/ARCHITECTURE.en.md) ([中文](docs/ARCHITECTURE.md))
- [Manual verification checklist](docs/manual-verification.md)
- [Changelog](CHANGELOG.md)

## Credits and license

The editor is adapted from Phoobobo's MIT-licensed [pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui). This fork is maintained by GeorgeDong32.

Claude Code is an Anthropic product. This is an independent Pi extension inspired by its terminal interface and is not affiliated with Anthropic.

Released under the [MIT License](LICENSE).
