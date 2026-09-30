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
	blinkGlyph,
	ccResult,
	mcpArgsSummary,
	mcpDisplayName,
	builtinCallArgs,
	callArgsFor,
	collapseCommand,
	dotStatus,
	strArg,
	subagentCallSummary,
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
	assert.deepEqual(ccCall(identity, "bash", '{"command":"ls"}', "running", 0).render(80), [
		"⏺ \u001b[38;2;255;255;255mbash({\"command\":\"ls\"})\u001b[39m",
	]);
});

test("ccCall ellipsizes args to the terminal width", () => {
	const rows = ccCall(identity, "bash", '{"command":"ls -la /very/long/path"}', "running", 0).render(18);
	assert.equal(rows.length, 1);
	assert.ok(rows[0]!.includes("\u001b[0m…\u001b[0m)"), rows[0]);
});

test("ccCall blinks the dot while running and keeps ⏺ on terminal states", () => {
	assert.equal(blinkGlyph("running", 0), "⏺");
	assert.equal(blinkGlyph("running", 600), " "); // blink-off half-cycle keeps the column
	assert.equal(blinkGlyph("running", 1200), "⏺");
	assert.equal(blinkGlyph("success", 500), "⏺");
	assert.equal(blinkGlyph("error", 500), "⏺");
	// Live rows read the clock inside render(): two renders 600ms apart differ.
	const c = ccCall(identity, "bash", "{}", "running", undefined as unknown as number);
	const a = c.render(80)[0]!.slice(0, 1);
	assert.ok(["⏺", " "].includes(a));
});

test("ccCall routes dot colors by status", () => {
	for (const [status, color] of [
		["running", "dim"],
		["success", "success"],
		["error", "error"],
	] as const) {
		const { theme, calls } = recordingTheme();
		ccCall(theme, "bash", "{}", status).render(80);
		assert.equal(calls[0]![0], color);
	}
});

test("ccCall keeps ⏺ on terminal states", () => {
	assert.ok(ccCall(identity, "bash", "{}", "success").render(80)[0]!.startsWith("⏺ "));
	assert.ok(ccCall(identity, "bash", "{}", "error").render(80)[0]!.startsWith("⏺ "));
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
	// core's obs_recall now has a dedicated CC-style summary (id [+ offset]).
	assert.equal(callArgsFor("obs_recall", { id: "obs_1", offset: 0 }), "obs_1");
	assert.equal(callArgsFor("obs_recall", { id: "obs_1", offset: 512 }), "obs_1 @512");
	assert.equal(callArgsFor("obs_recall", undefined), "");
	// Truly unknown (third-party) tools serialize — clamped to one line (CC rule).
	// clamp = 160 chars total: prefix {"a":" is 6 chars, so 159-6=153 xs + ellipsis.
	assert.equal(callArgsFor("zz_third", { a: "x".repeat(300) }), `{"a":"${"x".repeat(153)}…`);
	assert.equal(callArgsFor("zz_third", undefined), "{}");
});

test("callArgsFor routes subagent through the summary, unknown tools stay JSON", () => {
	assert.equal(
		callArgsFor("subagent", { agent: "pi-review.reviewer", task: "check" }),
		"reviewer · check",
	);
	assert.equal(callArgsFor("obs_recall", { id: "obs_1" }), "obs_1");
});

test("subagentCallSummary summarizes workflows by lanes (real-shape script)", () => {
	// Shape taken from a real pi-review fan-out (five reviewer lanes).
	const script = `
const reviewers = await runs.all([
  { key: "pi-review.claude-md-compliance", agent: "pi-review", task: "check CLAUDE.md rules" },
  { key: "pi-review.pr-guardrails", agent: "pi-review", task: "check PR guardrails" },
  { key: "pi-review.test-plan-honesty", agent: "pi-review", task: "check test plan honesty" },
  { key: "pi-review.arch-drift", agent: "pi-review", task: "check arch drift" },
  { key: "pi-review.license-hygiene", agent: "pi-review", task: "check license hygiene" },
]);
return reviewers;`;
	assert.equal(
		subagentCallSummary({ workflowScript: script }),
		"5×pi-review · check CLAUDE.md rul… · check PR guardrails · +3",
	);
	// Mixed agents aggregate with "+"; missing tasks fall back to the lane key.
	assert.equal(
		subagentCallSummary({
			workflowScript: 'const a = await runs.all([{ key: "a", agent: "worker", task: "修复登录页" }, { key: "r", agent: "reviewer" }]);',
		}),
		"worker+reviewer · 修复登录页 · r",
	);
	// Duplicate keys count once; single-lane scripts read as one agent.
	assert.equal(
		subagentCallSummary({ workflowScript: 'const a = await runs.one({ key: "solo.lane" });' }),
		"lane",
	);
	assert.equal(subagentCallSummary({ workflowScript: "const x = 1;" }), "workflow");
});

test("subagentCallSummary covers single agent, actions, paths, and fallback", () => {
	// CC parity: the model-written label IS the headline.
	assert.equal(subagentCallSummary({ agent: "delegate", label: "统计 proj 条目数" }), "统计 proj 条目数");
	assert.equal(subagentCallSummary({ agent: "explorer" }), "explorer");
	assert.equal(subagentCallSummary({ agent: "scout", task: "  概览  目录 结构 " }), "scout · 概览 目录 结构");
	// Paths collapse to the last segment; dates survive; labels strip.
	assert.equal(
		subagentCallSummary({ agent: "delegate", task: "READ-ONLY 演示：在 /Users/gd32/x/proj 下统计条目" }),
		"delegate · 演示：在 …/proj 下统计条目",
	);
	assert.equal(subagentCallSummary({ agent: "s", task: "核对 2026/09/27 的日志" }), "s · 核对 2026/09/27 的日志");
	// A task equal to the agent name would read as a stutter — show one word.
	assert.equal(subagentCallSummary({ agent: "go", task: "go" }), "go");
	assert.equal(subagentCallSummary({ action: "stop", id: "abc123" }), "stop abc123");
	assert.equal(subagentCallSummary({ action: "list" }), "list");
	assert.equal(
		subagentCallSummary({ workflowScriptPath: "/tmp/wf/review.mjs" }),
		"workflow review.mjs",
	);
	assert.equal(subagentCallSummary({ async: true }), '{"async":true}');
});

test("builtinCallArgs covers the built-ins plus the core tool family", () => {
	const keys = Object.keys(builtinCallArgs).sort();
	for (const must of ["bash", "edit", "find", "grep", "ls", "read", "write"]) assert.ok(keys.includes(must), must);
	for (const core of ["create_goal", "propose_goal_draft", "session_recall", "memory_consolidate", "obs_recall", "pi_review_report"]) {
		assert.ok(keys.includes(core), core);
	}
	// Core family summaries stay one-line headlines, never raw JSON.
	assert.ok(!callArgsFor("create_goal", { objective: "ship it" }).startsWith("{"));
	assert.ok(!callArgsFor("session_recall", { query: "goal state" }).startsWith("{"));
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

// SPEC 0.99-adapt MCP-01/02: official MCP tools (which carry their own
// renderers since pi 0.99) must render as CC rows.
test("mcpDisplayName converts official shapes to server/tool (MCP-01)", () => {
	assert.equal(mcpDisplayName("mcp__exa__search"), "exa/search");
	assert.equal(mcpDisplayName("mcp__github-ci__delete_branch"), "github-ci/delete_branch");
	assert.equal(mcpDisplayName("mcp_exa_search"), "exa/search");
	assert.equal(mcpDisplayName("read"), null);
	assert.equal(mcpDisplayName("subagent"), null);
	// Greedy server group matches core mcp-gov's canonicalization (known).
	assert.equal(mcpDisplayName("mcp__s__a__b"), "s__a/b");
});

test("mcpArgsSummary renders key=value pairs with a cap (MCP-01)", () => {
	assert.equal(mcpArgsSummary({ query: "pi mcp", limit: 5 }), "query=pi mcp limit=5");
	assert.equal(mcpArgsSummary({ nested: { a: 1 } }), 'nested={"a":1}');
	const long = mcpArgsSummary({ q: "x".repeat(120) });
	assert.equal(long.length, 78); // 75 chars + ellipsis, per the 78-char cap
	assert.ok(long.endsWith("…"));
	assert.equal(mcpArgsSummary(undefined), "");
});

test("CC call row for an MCP tool keeps the dot/bold shape (MCP-04)", () => {
	const row = ccCall(identity, mcpDisplayName("mcp__exa__search")!, mcpArgsSummary({ query: "hi" }), "success");
	const lines = row.render(90).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	const text = lines.join("\n");
	assert.ok(text.includes("exa/search"));
	assert.ok(text.includes("query=hi"));
});
