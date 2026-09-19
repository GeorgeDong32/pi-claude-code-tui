/**
 * Golden render tests for the CC tool rows (plan C3).
 *
 * These pin the exact rendered strings (identity theme) plus the color-name
 * routing (recording theme) so the A6 wrap-cache and any future render
 * change must stay byte-identical. keyText() returns "" outside a host
 * session, which is why expand hints read "(ctrl+o to expand)" here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	ccCall,
	ccResult,
	builtinCallArgs,
	callArgsFor,
	collapseCommand,
	dotStatus,
	strArg,
	textOfResult,
	thinkingToggleHint,
	type CCTheme,
} from "../extensions/lib/cc-rows.ts";

const identity: CCTheme = { fg: (_c, s) => s, bold: (s) => s };

/** Records which color names the renderer asks for. */
function recordingTheme(): { theme: CCTheme; calls: Array<[string, string]> } {
	const calls: Array<[string, string]> = [];
	return {
		calls,
		theme: {
			fg: (color, s) => {
				calls.push([color, s]);
				return s;
			},
			bold: (s) => s,
		},
	};
}

const result = (text: string): unknown => ({
	content: [{ type: "text", text }],
});

test("ccCall renders the CC call row with white tool name", () => {
	assert.deepEqual(ccCall(identity, "bash", '{"command":"ls"}', "running").render(80), [
		"⏺ \u001b[38;2;255;255;255mbash({\"command\":\"ls\"})\u001b[39m",
	]);
});

test("ccCall ellipsizes args to the terminal width", () => {
	const rows = ccCall(identity, "bash", '{"command":"ls -la /very/long/path"}', "running").render(18);
	assert.equal(rows.length, 1);
	assert.ok(rows[0]!.includes("\u001b[0m…\u001b[0m)"), rows[0]);
});

test("ccCall routes dot colors by status", () => {
	for (const [status, color] of [
		["running", "accent"],
		["success", "success"],
		["error", "error"],
	] as const) {
		const { theme, calls } = recordingTheme();
		ccCall(theme, "bash", "{}", status).render(80);
		assert.equal(calls[0]![0], color);
	}
});

test("ccResult short output passes through unwrapped", () => {
	assert.deepEqual(ccResult(identity, "bash", result("hello"), {}, false).render(80), [
		"  ⎿  hello",
	]);
});

test("ccResult at exactly MAX_RESULT_ROWS rows does not collapse", () => {
	assert.deepEqual(ccResult(identity, "bash", result("a\nb\nc"), {}, false).render(80), [
		"  ⎿  a",
		"     b",
		"     c",
	]);
});

test("ccResult collapses the 4th row and counts PHYSICAL rows", () => {
	assert.deepEqual(ccResult(identity, "bash", result("a\nb\nc\nd"), {}, false).render(80), [
		"  ⎿  a",
		"     b",
		"     ... +2 lines (ctrl+o to expand)",
	]);
	// A single 60-char logical line at width 20 wraps into 3 physical rows:
	// two shown + the third counted as +2 (wrap remainder + hint math).
	assert.deepEqual(ccResult(identity, "bash", result("x".repeat(60)), {}, false).render(20), [
		"  ⎿  xxxxxxxxxxxxxxx",
		"     xxxxxxxxxxxxxxx",
		"     ... +2 lines (ctrl+o to expand)",
	]);
});

test("ccResult expanded skips collapse", () => {
	assert.deepEqual(
		ccResult(identity, "bash", result("a\nb\nc\nd"), { expanded: true }, false).render(80),
		["  ⎿  a", "     b", "     c", "     d"],
	);
});

test("ccResult read collapses to a one-line summary", () => {
	assert.deepEqual(
		ccResult(identity, "read", result("l1\nl2\nl3\nl4\nl5"), {}, false).render(80),
		["  ⎿  Read 5 lines (ctrl+o to expand)"],
	);
});

test("ccResult empty output renders (no content)", () => {
	assert.deepEqual(ccResult(identity, "bash", result(""), {}, false).render(80), [
		"  ⎿  (no content)",
	]);
});

test("ccResult routes output through error color on error", () => {
	const { theme, calls } = recordingTheme();
	const rows = ccResult(theme, "bash", result("boom"), {}, true).render(80);
	assert.deepEqual(rows, ["  ⎿  boom"]);
	const colors = calls.map((c) => c[0]);
	assert.ok(colors.includes("dim"), "gutter is dim");
	assert.ok(colors.includes("error"), "error body is error-colored");
	assert.ok(!colors.includes("toolOutput"), "no normal output color on error");
});

test("helpers behave as pinned", () => {
	assert.equal(strArg("x"), "x");
	assert.equal(strArg(42), "");
	assert.equal(collapseCommand("one\ntwo"), "one …");
	assert.equal(collapseCommand("one"), "one");
	assert.equal(textOfResult(result("a\nb")), "a\nb");
	assert.equal(textOfResult({}), "");
	assert.equal(dotStatus({ isError: true }), "error");
	assert.equal(dotStatus({ isPartial: false }), "success");
	assert.equal(dotStatus(undefined), "running");
	assert.equal(dotStatus({ isPartial: true }), "running");
});

test("callArgsFor matches the built-in summaries and falls back to JSON", () => {
	assert.equal(callArgsFor("bash", { command: "git status\ngit diff" }), "git status …");
	assert.equal(callArgsFor("read", { path: "src/a.ts" }), "src/a.ts");
	assert.equal(callArgsFor("edit", { path: "src/a.ts", then_run: "bash:x" }), "src/a.ts");
	assert.equal(callArgsFor("grep", { pattern: "foo", path: "src" }), "foo in src");
	assert.equal(callArgsFor("grep", { pattern: "foo" }), "foo");
	assert.equal(callArgsFor("ls", {}), ".");
	// Unknown (third-party) tool names serialize the whole args object.
	assert.equal(callArgsFor("obs_recall", { id: "obs_1", offset: 0 }), '{"id":"obs_1","offset":0}');
	assert.equal(callArgsFor("obs_recall", undefined), "{}");
});

test("builtinCallArgs covers exactly the seven built-in tool names", () => {
	assert.deepEqual(Object.keys(builtinCallArgs).sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
});

test("thinkingToggleHint falls back to ctrl+t outside a host session", () => {
	// keyText returns "" when no keybindings manager is bound (tests run
	// without one), so the hint must never render as "( to expand)".
	assert.equal(thinkingToggleHint(), "ctrl+t");
});

test("ccResult wrap cache: repeat renders identical, width change recomputes, invalidate clears (plan A6)", () => {
	const big = "x".repeat(50) + "\n" + "y".repeat(50);
	const component = ccResult(identity, "bash", result(big), {}, false);
	const at80 = component.render(80);
	assert.deepEqual(component.render(80), at80, "same width returns the cached rows");
	const at20 = component.render(20);
	assert.equal(at20.length, 3, "narrow width re-wraps and collapses");
	assert.ok(at20[2]!.includes("lines"), at20[2]);
	assert.deepEqual(component.render(80), at80, "back to 80 serves the recomputed wide rows");
	component.invalidate();
	assert.deepEqual(component.render(80), at80, "after invalidate the output is still identical");
});
