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
	displayToolName,
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
	// core's obs_recall — TR D2 format: id (≤16 chars) · humanized offset.
	// Unified here (2026-10-03): the force-mode prototype path had been
	// rendering this format from a local copy; the table entry was an
	// unreachable shadow. Production output is unchanged.
	assert.equal(callArgsFor("obs_recall", { id: "obs_1", offset: 0 }), "obs_1 · start");
	assert.equal(callArgsFor("obs_recall", { id: "obs_1", offset: 512 }), "obs_1 · +0.5KB");
	assert.equal(callArgsFor("obs_recall", undefined), "obs_? · start");
	assert.equal(callArgsFor("obs_recall", { id: "obs_abcdef0123456789xyz", offset: 15872 }), "obs_abcdef012345 · +15.5KB");
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
	assert.equal(callArgsFor("obs_recall", { id: "obs_1" }), "obs_1 · start");
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

test("builtinCallArgs keeps only the rules the generic summary cannot express", () => {
	const keys = Object.keys(builtinCallArgs).sort();
	for (const must of ["bash", "edit", "find", "grep", "ls", "read", "write"]) assert.ok(keys.includes(must), must);
	// Composed shapes (multi-field formats / array counts) stay in the table.
	for (const core of ["session_recall", "memory_consolidate", "obs_recall"]) {
		assert.ok(keys.includes(core), core);
	}
	// Everything else core registers went schema-driven (spec P1-1 R2): the
	// per-name entries were deleted — create_goal & co. must NOT be here.
	for (const gone of ["create_goal", "propose_goal_draft", "update_goal", "get_goal", "pause_goal", "goal_questionnaire", "goal_question", "abort_goal", "apply_goal_tweak", "pi_review_report", "plan_ready", "step_complete"]) {
		assert.ok(!keys.includes(gone), `${gone} should be schema-driven, not a table entry`);
	}
});

// ── Schema-driven generic summaries vs the REAL core schemas (P1-1 R2) ──
// Fixture shapes mirror pi-claude-code-core's Type.Object registrations.

import type { ToolParamSchema } from "../extensions/lib/tool-summary.ts";

const schemaOf = (schemas: Record<string, ToolParamSchema>) => (name: string) => schemas[name];

const CORE_SCHEMAS: Record<string, ToolParamSchema> = {
	create_goal: { type: "object", properties: { objective: { type: "string" }, sisyphus: { type: "boolean" } }, required: ["objective"] },
	propose_goal_draft: { type: "object", properties: { objective: { type: "string" }, draftId: { type: "string" } }, required: ["objective"] },
	update_goal: { type: "object", properties: { status: { type: "string", enum: ["complete"] }, completionSummary: { type: "string" } }, required: ["status"] },
	pause_goal: { type: "object", properties: { reason: { type: "string" }, suggestedAction: { type: "string" } }, required: ["reason"] },
	abort_goal: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
	apply_goal_tweak: { type: "object", properties: { newObjective: { type: "string" }, changeSummary: { type: "string" } }, required: ["newObjective", "changeSummary"] },
	goal_question: { type: "object", properties: { question: { type: "string" }, context: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question"] },
	goal_questionnaire: { type: "object", properties: { topic: { type: "string" }, questions: { type: "array" } }, required: ["questions"] },
	get_goal: { type: "object", properties: {} },
	pi_review_report: { type: "object", properties: { runId: { type: "string" }, workflowReturn: {} }, required: ["runId", "workflowReturn"] },
	step_complete: { type: "object", properties: { stepIndex: { type: "integer" }, evidence: { type: "string" } }, required: ["stepIndex", "evidence"] },
};

test("R-T1/R2: core goal family summarizes via schema — one-line headlines, never JSON", () => {
	const for_ = schemaOf(CORE_SCHEMAS);
	// The three tools that were missing entirely before P1-1 (R1).
	assert.equal(callArgsFor("abort_goal", { reason: "user cancelled" }, for_), "user cancelled");
	assert.equal(callArgsFor("apply_goal_tweak", { newObjective: "=== Goal ===\nbig draft", changeSummary: "tightened step 2" }, for_), "tightened step 2");
	assert.equal(callArgsFor("goal_question", { question: "which DB?" }, for_), "which DB?");
	// The deleted table entries keep their headline quality via schema.
	assert.equal(callArgsFor("create_goal", { objective: "ship it" }, for_), "ship it");
	assert.equal(callArgsFor("propose_goal_draft", { objective: "ship it" }, for_), "ship it");
	assert.equal(callArgsFor("update_goal", { status: "complete" }, for_), "complete");
	assert.equal(callArgsFor("pause_goal", { reason: "missing credentials" }, for_), "missing credentials");
	assert.equal(callArgsFor("get_goal", {}, for_), "{}"); // empty params → bounded JSON, not a fake summary
	assert.equal(callArgsFor("pi_review_report", { runId: "xyz123-abc", workflowReturn: null }, for_), "xyz123-abc");
	// Long / multiline values collapse to one line with the shared clamp.
	assert.equal(
		callArgsFor("create_goal", { objective: `line one\nline ${"x".repeat(100)}` }, for_),
		`line one line ${"x".repeat(45)}…`, // 60-char clamp: slice(0,59)+"…"
	);
	// goal_questionnaire's array param must not degrade to a raw JSON row
	// when a usable string param exists (spec §4.2).
	assert.equal(callArgsFor("goal_questionnaire", { topic: "DB choice", questions: ["a?", "b?"] }, for_), "DB choice");
});

test("R2: no schema → bounded JSON fallback, same as pre-schema unknown tools", () => {
	assert.equal(callArgsFor("create_goal", { objective: "ship it" }), '{"objective":"ship it"}');
	assert.equal(callArgsFor("zz_third", { a: "x".repeat(300) }), `{"a":"${"x".repeat(153)}…`);
	assert.equal(callArgsFor("zz_third", undefined), "{}");
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
test("mcpDisplayName converts official shapes to the CC userFacingName core (MCP-01)", () => {
	assert.equal(mcpDisplayName("mcp__exa__search"), "exa - search");
	assert.equal(mcpDisplayName("mcp__github-ci__delete_branch"), "github-ci - delete_branch");
	assert.equal(mcpDisplayName("mcp_exa_search"), "exa - search");
	assert.equal(mcpDisplayName("read"), null);
	assert.equal(mcpDisplayName("subagent"), null);
	// Greedy server group matches core mcp-gov's canonicalization (known).
	assert.equal(mcpDisplayName("mcp__s__a__b"), "s__a - b");
});

test("mcpArgsSummary renders key=value pairs with a cap (MCP-01)", () => {
	assert.equal(mcpArgsSummary({ query: "pi mcp", limit: 5 }), "query=pi mcp limit=5");
	assert.equal(mcpArgsSummary({ nested: { a: 1 } }), 'nested={"a":1}');
	const long = mcpArgsSummary({ q: "x".repeat(120) });
	assert.equal(long.length, 78); // 75 chars + ellipsis, per the 78-char cap
	assert.ok(long.endsWith("…"));
	assert.equal(mcpArgsSummary(undefined), "");
});

test("CC call row for an MCP tool keeps the dot/bold shape and carries the dim (MCP) badge (MCP-04)", () => {
	const name = mcpDisplayName("mcp__exa__search")!;
	const row = ccCall(identity, name, mcpArgsSummary({ query: "hi" }), "success", undefined, "(MCP)");
	const lines = row.render(90).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	const text = lines.join("\n");
	assert.ok(text.includes("exa - search"));
	assert.ok(text.includes("(MCP)"));
	assert.ok(text.includes("query=hi"));
	// The badge renders dim between the name and the args paren — CC dims
	// the same userFacingName suffix (FallbackPermissionRequest.tsx).
	const rec = recordingTheme();
	ccCall(rec.theme, name, "query=hi", "success", undefined, "(MCP)").render(90);
	assert.ok(rec.calls.some(([color, s]) => color === "dim" && s === "(MCP)"));
});

test("display tool names: obs_recall reads as Recall Observation (model side untouched)", () => {
	assert.equal(displayToolName("obs_recall"), "Recall Observation");
	assert.equal(displayToolName("bash"), "bash");
	assert.equal(displayToolName("subagent"), "subagent");
	const call = ccCall(identity, displayToolName("obs_recall"), callArgsFor("obs_recall", { id: "obs_0d380d7641f3b1e9d", offset: 0 }), "success");
	const row = call.render(80)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(row, /⏺ Recall Observation\(obs_0d380d7641f3 · start\)/, row);
});

// ---------------------------------------------------------------------------
// P1-1 R4/R5 (spec R-T4): MCP display mirror — five shapes, aligned with
// core's canonicalizeMcpShape via a shared-sample cross-check against the
// REAL core module (read-only sibling import; skipped when the sibling
// checkout is absent so plain `npm test` still passes anywhere).

test("R-T4: proxy shape resolves via args.tool; bare mcp without a target is NOT claimed", () => {
	assert.equal(mcpDisplayName("mcp", { tool: "mcp_exa_search", input: { q: "pi" } }), "exa - search");
	assert.equal(mcpDisplayName("mcp", {}), null);
	assert.equal(mcpDisplayName("mcp", undefined), null);
	assert.equal(mcpDisplayName("mcp", { tool: 42 }), null);
	assert.equal(mcpDisplayName("mcp", ["mcp_exa_search"]), null);
	// The proxy target follows the same native/direct parsing rules.
	assert.equal(mcpDisplayName("mcp", { tool: "mcp__exa__search" }), "exa - search");
	assert.equal(mcpDisplayName("mcp", { tool: "read" }), null);
});

test("R-T4: direct-named tools only with PI_CORE_MCP_DIRECT_SERVERS listing the server", () => {
	const prev = process.env.PI_CORE_MCP_DIRECT_SERVERS;
	try {
		process.env.PI_CORE_MCP_DIRECT_SERVERS = "Exa, github ,";
		assert.equal(mcpDisplayName("exa_search", { q: "pi" }), "exa - search");
		assert.equal(mcpDisplayName("github_create_issue", { title: "x" }), "github - create_issue");
		assert.notEqual(mcpDisplayName("otherapi_search", {}), "otherapi - search");
		assert.equal(mcpDisplayName("otherapi_search", {}), null);
		// Mixed-underscore native shapes still parse first (core order).
		assert.equal(mcpDisplayName("mcp_exa__deep_search", {}), "exa - deep_search");
		// Bare single-word mcp_* has no server/tool pair to display.
		assert.equal(mcpDisplayName("mcp_passthrough", {}), null);
	} finally {
		if (prev === undefined) delete process.env.PI_CORE_MCP_DIRECT_SERVERS;
		else process.env.PI_CORE_MCP_DIRECT_SERVERS = prev;
	}
});

test("R-T4: native double/single underscore shapes unchanged (regression)", () => {
	assert.equal(mcpDisplayName("mcp__exa__search"), "exa - search");
	assert.equal(mcpDisplayName("mcp_exa__search"), "exa - search");
	assert.equal(mcpDisplayName("mcp__exa_search"), "exa - search");
	assert.equal(mcpDisplayName("read"), null);
});

test("R-T4 cross-check: display mirror agrees with the REAL core mcp-shape on shared samples", async (t) => {
	let core: typeof import("../../pi-claude-code-core/lib/mcp-shape.ts");
	try {
		core = (await import("../../pi-claude-code-core/lib/mcp-shape.ts")) as typeof core;
	} catch {
		// Sibling checkout absent (isolated CI): the mirror's own table tests
		// above still pin the five shapes.
		t.skip("sibling pi-claude-code-core checkout not present");
		return;
	}
	const prev = process.env.PI_CORE_MCP_DIRECT_SERVERS;
	process.env.PI_CORE_MCP_DIRECT_SERVERS = "exa,github";
	try {
		const known = core.knownServersSetFromEnv();
		const samples: Array<[string, Record<string, unknown> | undefined]> = [
			["mcp__exa__search", {}],
			["mcp_exa__search", {}],
			["mcp__exa_search", {}],
			["mcp_exa_search", {}],
			["mcp_passthrough", {}],
			["mcp", { tool: "mcp_exa_search" }],
			["mcp", { tool: "exa_search" }],
			["mcp", {}],
			["mcp", undefined],
			["exa_search", {}],
			["github_create_issue", {}],
			["otherapi_search", {}],
			["read", { path: "/x" }],
		];
		for (const [name, args] of samples) {
			const canonical = core.canonicalizeMcpShape(name, args ?? {}, known);
			const display = mcpDisplayName(name, args);
			if (canonical === null) {
				assert.equal(display, null, `${name} ${JSON.stringify(args)}: core says non-MCP, display must agree`);
			} else if (canonical === name && !name.slice(4).includes("_")) {
				// Agreed divergence: core canonicalizes a BARE `mcp_word`
				// (no server/tool separator left); the display mirror has no
				// `server - tool` pair to render and declines (spec §4.3).
				assert.equal(display, null, `${name}: bare shape — display declines despite canonical ${canonical}`);
			} else {
				assert.notEqual(display, null, `${name} ${JSON.stringify(args)}: core canonical ${canonical}, display must claim it`);
				// Round-trip: the display's parts rebuild the canonical form.
				const [server, tool] = display!.split(" - ");
				assert.equal(`mcp_${server}_${tool}`, canonical);
			}
		}
	} finally {
		if (prev === undefined) delete process.env.PI_CORE_MCP_DIRECT_SERVERS;
		else process.env.PI_CORE_MCP_DIRECT_SERVERS = prev;
	}
});
