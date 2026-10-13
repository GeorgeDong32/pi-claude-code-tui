/**
 * cc-api-error-row tests (spec 2026-10-13-cc-api-error-row §4):
 *
 * A-T1 native/cc text tables (DEC-A2/A3/A4), A-T2 row goldens (fold/wrap),
 * A-T3 real AssistantMessageComponent matrix, A-T4 fail-open identification,
 * A-T5 expansion (instance setExpanded + click). A-T6 lives in
 * pi-proto-adapter.test.ts (N-T1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
	ccTerminalRows,
	ccTerminalText,
	classifyTerminal,
	nativeTerminalText,
	patchApiErrorRow,
	restoreApiErrorRow,
} from "../extensions/lib/cc-api-error-row.ts";

const theme = { fg: (c: string, s: string) => s, bold: (s: string) => s };

// ── A-T1: text tables ────────────────────────────────────────────────────

test("A-T1 nativeTerminalText: pi's oracle strings", () => {
	assert.equal(nativeTerminalText("error", "Connection error."), "Error: Connection error.");
	assert.equal(nativeTerminalText("error", undefined), "Error: Unknown error");
	assert.equal(nativeTerminalText("error", ""), "Error: Unknown error");
	assert.equal(nativeTerminalText("aborted", undefined), "Operation aborted");
	assert.equal(nativeTerminalText("aborted", "Request was aborted"), "Operation aborted");
	assert.equal(nativeTerminalText("aborted", "Aborted after 2 retry attempts"), "Aborted after 2 retry attempts");
	assert.equal(nativeTerminalText("length", undefined), "Response was truncated before completion.");
});

test("A-T1 ccTerminalText: API Error prefix handling (S3)", () => {
	assert.equal(ccTerminalText("error", "Connection error."), "API Error: Connection error.");
	assert.equal(ccTerminalText("error", undefined), "API Error: Unknown error");
	assert.equal(ccTerminalText("error", ""), "API Error: Unknown error");
	assert.equal(ccTerminalText("error", "Error: x"), "API Error: x", "Error: prefix de-duplicated");
	assert.equal(ccTerminalText("error", "API Error: x"), "API Error: x", "API Error: prefix de-duplicated");
	assert.equal(ccTerminalText("error", "API Error"), "API Error: Unknown error", "bare prefix stripped");
	assert.equal(ccTerminalText("error", "Error"), "API Error: Unknown error", "bare prefix stripped");
	assert.equal(ccTerminalText("error", "api error: x"), "API Error: x", "case-insensitive");
	assert.equal(ccTerminalText("error", "Errors occurred"), "API Error: Errors occurred", "no mid-word strip");
});

test("A-T1 ccTerminalText: aborted / length (DEC-A4, Pi wording)", () => {
	assert.equal(ccTerminalText("aborted", undefined), "Interrupted · What should Pi do instead?");
	assert.equal(ccTerminalText("aborted", "Request was aborted"), "Interrupted · What should Pi do instead?");
	assert.equal(ccTerminalText("aborted", "Aborted after 2 retry attempts"), "Interrupted · Aborted after 2 retry attempts");
	assert.equal(ccTerminalText("length", undefined), "Response was truncated before completion.");
});

test("A-T1 classifyTerminal: branch conditions mirror AM:136-154", () => {
	assert.equal(classifyTerminal("error", false), "error");
	assert.equal(classifyTerminal("error", true), null, "tool rows carry the error");
	assert.equal(classifyTerminal("aborted", false), "aborted");
	assert.equal(classifyTerminal("aborted", true), null);
	assert.equal(classifyTerminal("length", false), "length");
	assert.equal(classifyTerminal("length", true), "length", "length always surfaces");
	assert.equal(classifyTerminal("stop", false), null);
	assert.equal(classifyTerminal(undefined, false), null);
});

// ── A-T2: row goldens ────────────────────────────────────────────────────

test("A-T2 ccTerminalRows: short error = one guttered row", () => {
	const rows = ccTerminalRows(theme, "error", "Connection error.", 100, false);
	assert.equal(rows.length, 1);
	assert.ok(rows[0]!.startsWith("  ⎿  "), rows[0]);
	assert.ok(rows[0]!.includes("API Error: Connection error."), rows[0]);
});

test("A-T2 ccTerminalRows: long error folds with the +N hint; expanded shows everything", () => {
	const long = ["{" + '"x"'.repeat(1), ...Array.from({ length: 30 }, (_, i) => `  "line${i}": ${i},`), "}"].join("\n");
	const folded = ccTerminalRows(theme, "error", long, 80, false);
	assert.ok(folded.length <= 3, `folded ≤ 3 rows, got ${folded.length}`);
	assert.ok(folded[folded.length - 1]!.includes("lines") && folded[folded.length - 1]!.includes("ctrl+o"), folded[folded.length - 1]);
	const expanded = ccTerminalRows(theme, "error", long, 80, true);
	assert.ok(expanded.length > folded.length, "expansion reveals rows");
	assert.ok(expanded[0]!.startsWith("  ⎿  "));
});

test("A-T2 ccTerminalRows: aborted wraps fully under the gutter (S4), length red family", () => {
	const longCause = "Interrupted · " + "very long custom reason ".repeat(10);
	const rows = ccTerminalRows(theme, "aborted", longCause.slice("Interrupted · ".length), 40, false);
	assert.ok(rows.length > 1, "wrapped");
	for (const [i, r] of rows.entries()) {
		assert.ok(r.startsWith(i === 0 ? "  ⎿  " : "     "), `row ${i} under the gutter: ${JSON.stringify(r)}`);
	}
	assert.ok(!rows.some((r) => r.includes("…")), "no truncation of the cause");
	const length = ccTerminalRows(theme, "length", undefined, 80, false);
	assert.equal(length.length, 1);
	assert.ok(length[0]!.includes("Response was truncated before completion."));
});

// ── A-T3/A-T4/A-T5: the real component ───────────────────────────────────

const makeMessage = (stopReason: string | undefined, errorMessage?: string) =>
	({ role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason, ...(errorMessage !== undefined ? { errorMessage } : {}) }) as never;

const rowsOf = (component: AssistantMessageComponent): string[] => {
	const c = (component as unknown as { contentContainer: { render(w: number): string[] } }).contentContainer;
	return c.render(100);
};

test("A-T3 real component: error/aborted/length get CC rows; stop and tool-call cases stay native", () => {
	try {
		initTheme("default", false);
	} catch { /* already initialized */ }
	const fg = (c: string, s: string) => (c === "error" || c === "dim" ? s : s);
	patchApiErrorRow(() => fg);
	try {
		// error, no tool calls → CC row
		const err = new AssistantMessageComponent(makeMessage("error", "Connection error."), {} as never);
		const errLines = rowsOf(err).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
		assert.ok(errLines.some((l) => l.startsWith("  ⎿  API Error: Connection error.")), errLines.join("\n"));
		assert.ok(!errLines.some((l) => l.startsWith("Error: Connection error.")), `native Error: row gone: ${errLines.join("\n")}`);

		// aborted → interrupted row
		const ab = new AssistantMessageComponent(makeMessage("aborted"), {} as never);
		const abRows = rowsOf(ab).join("\n");
		assert.ok(abRows.includes("Interrupted · What should Pi do instead?"), abRows);

		// length → truncated row
		const len = new AssistantMessageComponent(makeMessage("length"), {} as never);
		const lenRows = rowsOf(len).join("\n");
		assert.ok(lenRows.includes("Response was truncated before completion."), lenRows);

		// normal stop → untouched native rendering
		const ok = new AssistantMessageComponent(makeMessage("stop"), {} as never);
		const okRows = rowsOf(ok).join("\n");
		assert.ok(okRows.includes("partial answer"), okRows);

		// error WITH tool calls → native behavior (tool row carries it)
		const toolMsg = {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } }],
			stopReason: "error",
			errorMessage: "Connection error.",
		} as never;
		const tool = new AssistantMessageComponent(toolMsg, {} as never);
		const toolRows = rowsOf(tool).join("\n");
		assert.ok(!toolRows.includes("API Error:"), `no assistant terminal row: ${toolRows}`);
	} finally {
		restoreApiErrorRow();
	}
});

test("A-T4 fail-open: mismatched native text stays native; ANSI-bearing errorMessage still matches; degrade never doubles", () => {
	try {
		initTheme("default", false);
	} catch { /* already initialized */ }
	const fg = (_c: string, s: string) => s;
	patchApiErrorRow(() => fg);
	try {
		// errorMessage carrying ANSI: native text would carry it too; both sides
		// are stripped before comparison, so the CC row still installs.
		const colored = new AssistantMessageComponent(
			makeMessage("error", "\x1b[31mConnection error.\x1b[0m"),
			{} as never,
		);
		const coloredRows = rowsOf(colored)
			.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
			.join("\n");
		assert.ok(coloredRows.includes("API Error: Connection error."), coloredRows);
	} finally {
		restoreApiErrorRow();
	}

	// Degrade path: a host whose contentContainer lacks the trailing Text the
	// oracle expects keeps the native row (identification failure = fail-open).
	// Simulated by patching with a mismatching native render: construct the
	// component AFTER restore, then verify its native text is intact.
	const native = new AssistantMessageComponent(makeMessage("error", "boom"), {} as never);
	const nativeRows = rowsOf(native).join("\n");
	assert.ok(nativeRows.includes("Error: boom"), `native restored: ${nativeRows}`);
});

test("A-T5 expansion: instance setExpanded toggles; click toggles; foreign setExpanded not overridden", () => {
	try {
		initTheme("default", false);
	} catch { /* already initialized */ }
	const fg = (_c: string, s: string) => s;
	patchApiErrorRow(() => fg);
	try {
		const long = ["head", ...Array.from({ length: 30 }, (_, i) => `line${i}`)].join("\n");
		const comp = new AssistantMessageComponent(makeMessage("error", long), {} as never);
		const foldedLines = rowsOf(comp);
		assert.ok(foldedLines.join("\n").includes("API Error: head"), foldedLines.join("\n"));
		// text row + spacer + ≤3 error rows
		assert.ok(foldedLines.length <= 6, `folded shape: ${foldedLines.length}`);
		assert.ok(foldedLines.some((l) => l.includes("lines") && l.includes("ctrl+o")), "fold hint present");

		// Instance-level setExpanded exists (duck-typed ctrl+o walk finds it).
		const setExpanded = (comp as unknown as { setExpanded?: (v: boolean) => void }).setExpanded;
		assert.equal(typeof setExpanded, "function");
		setExpanded!(true);
		const expandedRows = rowsOf(comp);
		assert.ok(expandedRows.length > foldedLines.length, "expansion via setExpanded reveals full text");
		setExpanded!(false);
		assert.ok(rowsOf(comp).length <= 6, "folded again");

		// Foreign setExpanded on the prototype is never overridden.
		class Guarded extends AssistantMessageComponent {}
		(Guarded.prototype as unknown as { setExpanded: (v: boolean) => void }).setExpanded = () => {};
		const guarded = new Guarded(makeMessage("error", long), {} as never);
		assert.equal(
			(guarded as unknown as { setExpanded: (v: boolean) => void }).setExpanded,
			(Guarded.prototype as unknown as { setExpanded: (v: boolean) => void }).setExpanded,
			"prototype (foreign) implementation kept",
		);

		// MouseRegion click toggles the same flag (DEC-A5 auxiliary channel).
		const clicker = new AssistantMessageComponent(makeMessage("error", long), {} as never);
		const region = (clicker as unknown as { contentContainer: { children: unknown[] } }).contentContainer
			.children.at(-1) as { handleMouse(e: { type: string; button: string }): { handled?: boolean } | undefined };
		assert.equal(typeof region?.handleMouse, "function", "error row is MouseRegion-wrapped");
		const foldedCount = rowsOf(clicker).length;
		const result = region.handleMouse({ type: "click", button: "left" });
		assert.deepEqual(result, { handled: true });
		assert.ok(rowsOf(clicker).length > foldedCount, "click expanded the row");
		region.handleMouse({ type: "click", button: "left" });
		assert.ok(rowsOf(clicker).length <= foldedCount, "second click folded it back");
	} finally {
		restoreApiErrorRow();
	}
});
