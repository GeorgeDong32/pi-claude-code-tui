/**
 * Claude Code-style tool rows (plan C3 extraction).
 *
 * Pure renderers extracted verbatim from claude-code-tui.ts so they can be
 * golden-tested without the extension factory (theme is duck-typed and
 * injected). Behavior must stay byte-identical — the golden tests in
 * test/cc-rows.golden.test.ts are the equivalence net for the A6 wrap-cache
 * and future render changes.
 */

import { keyText, renderDiff } from "@earendil-works/pi-coding-agent";

/** Expand keybinding with a hard fallback (plan B4): keyText yields "" for
 *  unregistered bindings (e.g. outside a host session), which rendered a
 *  bare "( to expand)" — "ctrl+o" is pi's default tools-expand binding. */
const expandKeyHint = (): string => keyText("app.tools.expand") || "ctrl+o";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const RESET = "\x1b[39m";

export const strArg = (v: unknown): string => (typeof v === "string" ? v : "");
export const collapseCommand = (cmd: string): string => {
	const first = cmd.split("\n")[0] ?? "";
	return cmd.includes("\n") ? `${first} …` : first;
};

export const textOfResult = (result: unknown): string => {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
};

export interface CCTheme {
	fg(color: string, s: string): string;
	bold(s: string): string;
}

// ⏺ dot state (CC): orange while running, green on success, red on error.
export type CCDotStatus = "running" | "success" | "error";
const DOT_COLOR: Record<CCDotStatus, string> = {
	running: "accent",
	success: "success",
	error: "error",
};
export const dotStatus = (rctx?: { isError?: boolean; isPartial?: boolean }): CCDotStatus => {
	if (rctx?.isError) return "error";
	if (rctx?.isPartial === false) return "success";
	return "running";
};

// `⏺ Tool(args)` call row: single line with args ellipsized to fit (CC
// style), so long commands can never wrap or misalign the dot.
export const ccCall = (theme: CCTheme, name: string, args: string, status: CCDotStatus) => ({
	invalidate() {},
	render(width: number): string[] {
		const white = "\x1b[38;2;255;255;255m";
		const head = `${theme.fg(DOT_COLOR[status], "⏺")} ${white}${theme.bold(name)}(`;
		const avail = Math.max(1, width - visibleWidth(head) - 1);
		const shown = truncateToWidth(args, avail, "…");
		return [`${head}${shown})${RESET}`];
	},
});

// `⎿  output` result rows: dim gutter, output wrapped and aligned under the
// gutter, collapsed preview with expand hint, red on error. Collapse is
// capped at MAX_RESULT_ROWS PHYSICAL rows: a single minified JSON line can
// wrap into dozens of terminal rows, so counting logical lines is not enough.
export const MAX_RESULT_ROWS = 3;

export const ccResult = (
	theme: CCTheme,
	name: string,
	result: unknown,
	options: { expanded?: boolean },
	isError: boolean,
) => {
	// Wrap-once cache (plan A6): render() is called every frame and wrapping a
	// large output costs one ANSI-aware wrap per logical line. All inputs the
	// output depends on are factory arguments, so a (width) key is sufficient;
	// a width change (terminal resize) recomputes.
	let renderCache: { width: number; rows: string[] } | null = null;
	return {
		invalidate() {
			renderCache = null;
		},
		render(width: number): string[] {
			if (renderCache && renderCache.width === width) return renderCache.rows;
			const rows = renderRows(width);
			renderCache = { width, rows };
			return rows;
		},
	};

	function renderRows(width: number): string[] {
		const gutter = theme.fg("dim", "  ⎿  ");
		const cont = "     ";
		const paint = (s: string) => (isError ? theme.fg("error", s) : theme.fg("toolOutput", s));
		const wrapW = Math.max(10, width - cont.length);
		const expandHint = theme.fg("dim", `(${expandKeyHint()} to expand)`);

		// Wraps pre-colored logical lines into physical rows and, unless expanded,
		// caps the block at MAX_RESULT_ROWS rows total (expand hint included).
		const emit = (logicalLines: string[]): string[] => {
			const physical: string[] = [];
			for (const line of logicalLines) physical.push(...wrapTextWithAnsi(line, wrapW));
			if (options.expanded || physical.length <= MAX_RESULT_ROWS) {
				return physical.map((l, i) => `${i === 0 ? gutter : cont}${l}`);
			}
			const shown = physical.slice(0, MAX_RESULT_ROWS - 1);
			const rows = shown.map((l, i) => `${i === 0 ? gutter : cont}${l}`);
			rows.push(`${cont}${theme.fg("dim", `... +${physical.length - shown.length} lines`)} ${expandHint}`);
			return rows;
		};

		const output = textOfResult(result).replace(/\n+$/, "");
		const lines = output ? output.split("\n") : [];

		// Errors: red summary lines, like CC's `⎿  Error: ...`
		if (isError) {
			return emit((lines.length ? lines : ["Error"]).map((l) => theme.fg("error", l)));
		}

		// Edit: summary + colored diff
		if (name === "edit") {
			const diff = (result as { details?: { diff?: string } }).details?.diff;
			const logical = [lines[0] || "Updated file"];
			if (diff) logical.push(...renderDiff(diff).split("\n"));
			return emit(logical);
		}

		// Read collapsed: one-line summary, like CC
		if (name === "read" && !options.expanded) {
			return [
				`${gutter}${theme.fg("toolOutput", `Read ${lines.length} lines`)} ${theme.fg("dim", `(${expandKeyHint()} to expand)`)}`,
			];
		}

		if (lines.length === 0) {
			return [`${gutter}${theme.fg("toolOutput", "(no content)")}`];
		}

		// Generic collapsed preview
		return emit(lines.map(paint));
	}
};
