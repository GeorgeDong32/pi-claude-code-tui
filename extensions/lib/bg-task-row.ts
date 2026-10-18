/**
 * The bg-shell task-status pseudo tool row (CC parity, spec BG-ENTRY-03).
 *
 * core's bg-shell appends a display-only session entry
 * (`cc-core-bg-shell-task`, data `{id, command, state, exitCode?, runtimeMs}`)
 * on every background-task completion and user kill; THIS package is its
 * only renderer (core deliberately registers none — first-wins renderer
 * lookup would shadow us). The row mimics the observation-packed pseudo
 * tool row: a `⏺ Background Task(bg-N)` call row whose dot speaks the
 * tool-call status language, plus one `⎿` detail gutter — visually paired
 * with the `⏺ TaskOutput(bg-N)` rows the agent emits right after.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";

import { ccCall, type CCTheme } from "./cc-rows.ts";

/** Duck-typed mirror of core bg-shell's TaskStatusData (BG-ENTRY-03). */
export interface BgTaskEventData {
	id: string;
	command: string;
	/** Optional human label the model gave the call (CC description parity). */
	description?: string;
	state: string;
	exitCode?: number;
	runtimeMs: number;
}

/** `1.2s`, or `2m 5s` from a minute on (same scale as core's formatRuntime). */
function formatRuntime(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

/** One line of truth for a command (newlines as ⏎), cut to 120 characters. */
function oneLine(command: string): string {
	const line = command.replace(/\s*\n\s*/g, " ⏎ ");
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** The status wording, CC GenericTaskStatus parity. */
function wording(data: BgTaskEventData): string {
	if (data.state === "killed") return "stopped";
	if (data.state === "exited")
		return data.exitCode === 0 ? "completed in background" : `failed in background (exit ${data.exitCode})`;
	return "ended in background";
}

/** The two rendered rows: call row + ⎿ detail gutter. */
export const bgTaskRows = (theme: CCTheme, data: BgTaskEventData, width: number): string[] => {
	const status = data.state === "exited" ? (data.exitCode === 0 ? "success" : "error") : "running";
	// "running" is the CCDotStatus whose DOT_COLOR is dim — right for a stop —
	// but it also blinks; pin `now` to an even phase so the dot stays solid.
	const now = status === "running" ? 0 : undefined;
	// CC GenericTaskStatus shows ONLY the description ('Task "desc" completed')
	// — the id lives model-side (the notification) and in /tasks. Bare id when
	// the model gave no label.
	// CC GenericTaskStatus shows ONLY the description; the /tasks panel falls
	// back to the command for label-less bash tasks — same split here. The
	// call row truncates to the terminal width itself (ccCall), never wraps.
	const args = data.description === undefined || data.description === "" ? oneLine(data.command) : data.description;
	const call = ccCall(theme, "Background Task", args, status, now).render(width)[0] ?? "";
	const tail = args === oneLine(data.command) ? "" : ` · ${oneLine(data.command)}`;
	const detail = `${theme.fg("dim", "  ⎿  ")}${theme.fg("toolOutput", `${wording(data)} · ran ${formatRuntime(data.runtimeMs)}${tail}`)}`;
	return [truncateToWidth(call, width, "…"), truncateToWidth(detail, width, "…")];
};
