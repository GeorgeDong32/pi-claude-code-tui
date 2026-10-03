/**
 * Takeover matrix tests: every combination of the decision inputs, pinned
 * per slot. This is the safety net for the three inline condition chains
 * that used to live inside the prototype patch (call/result/renderShell) —
 * review fixes edf4fce (MCP exception scope) and eb4dc7c (obs_recall
 * exemption) were bugs in exactly this matrix. Since the 1.0
 * registerToolRenderer migration it also pins the resolver-channel planner
 * (planResolverTakeover), including the P1-1 rule that the yield path keeps
 * its flat "self" shell.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	BUILTIN_SEVEN,
	decideTakeover,
	FORCE_RESULT_EXEMPT,
	isBuiltinToolName,
	planResolverTakeover,
} from "../extensions/lib/takeover-rules.ts";

type Row = [boolean, boolean, boolean, boolean, boolean, boolean];

const ALL_BOOLS: Row[] = [];
for (const enabled of [false, true])
	for (const toolRows of [false, true])
		for (const forced of [false, true])
			for (const isMcp of [false, true])
				for (const isBuiltin of [false, true])
					for (const hasOrig of [false, true]) ALL_BOOLS.push([enabled, toolRows, forced, isMcp, isBuiltin, hasOrig]);

const d = (r: Row, slot: "call" | "result", toolName = "zz_third") =>
	decideTakeover({
		enabled: r[0], toolRowsEnabled: r[1], forced: r[2], isMcp: r[3], isBuiltin: r[4], hasOrig: r[5],
		toolName, slot,
	});

test("user switches gate everything — any off ⇒ orig on every slot", () => {
	for (const r of ALL_BOOLS.filter((x) => !x[0] || !x[1])) {
		assert.equal(d(r, "call"), "orig", JSON.stringify(r));
		assert.equal(d(r, "result"), "orig", JSON.stringify(r));
	}
});

test("call slot: MCP always ours; builtin seven ours when rows on; third-party by force or vacancy", () => {
	for (const r of ALL_BOOLS.filter((x) => x[0] && x[1])) {
		const [, , forced, isMcp, isBuiltin, hasOrig] = r;
		const got = d(r, "call");
		let want: "orig" | "cc";
		if (isMcp) want = "cc";
		else if (isBuiltin) want = "cc";
		else if (!hasOrig) want = "cc";
		else want = forced ? "cc" : "orig";
		assert.equal(got, want, JSON.stringify(r));
	}
});

test("result slot: identical to call except FORCE_RESULT_EXEMPT keeps the tool's own renderer in force mode", () => {
	for (const r of ALL_BOOLS.filter((x) => x[0] && x[1])) {
		const call = d(r, "call");
		const result = d(r, "result", "zz_third");
		assert.equal(result, call, `non-exempt tool: result slot must track call slot — ${JSON.stringify(r)}`);
	}
	// Exempt tools: force mode still yields the result slot (but never the call row).
	for (const name of FORCE_RESULT_EXEMPT) {
		const r: Row = [true, true, true, false, false, true];
		assert.equal(d(r, "result", name), "orig", `${name} result exempt in force mode`);
		assert.equal(d(r, "call", name), "cc", `${name} call row stays ours`);
		// Exemption only applies with something to yield to and in force
		// mode; auto mode yields anyway, vacancy takes over regardless.
		assert.equal(d([true, true, false, false, false, true], "result", name), "orig", "auto mode yields");
		assert.equal(d([true, true, true, false, false, false], "result", name), "cc", "vacancy takes over despite exemption");
	}
});

test("edf4fce regression: MCP exception exempts only builtin-check + auto-yield, never the user switches", () => {
	// An MCP tool with its own renderer stays ours even in AUTO mode…
	assert.equal(d([true, true, false, true, false, true], "call"), "cc");
	// …but the user turning tool rows off always wins over the MCP exception.
	assert.equal(d([true, false, true, true, false, true], "call"), "orig");
	assert.equal(d([false, true, true, true, false, true], "call"), "orig");
});

test("BUILTIN_SEVEN: exactly the seven migrated names; powershell deliberately excluded (r2 load-bearing note)", () => {
	assert.deepEqual([...BUILTIN_SEVEN].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	for (const name of BUILTIN_SEVEN) assert.equal(isBuiltinToolName(name), true, name);
	// pi's builtin renderer table has an eighth key; it must stay third-party
	// (stock under auto, CC only via force) — not a builtin-seven member.
	assert.equal(isBuiltinToolName("powershell"), false);
});

// ── planResolverTakeover (resolver channel, DEC-05/06) ──

type PlanRow = [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
// [channelActive, toolRowsEnabled, forced, isMcp, isBuiltin, hasOrigCall, hasOrigResult]
const ALL_PLAN_BOOLS: PlanRow[] = [];
for (const channelActive of [false, true])
	for (const toolRows of [false, true])
		for (const forced of [false, true])
			for (const isMcp of [false, true])
				for (const isBuiltin of [false, true])
					for (const hasOrigCall of [false, true])
						for (const hasOrigResult of [false, true])
							ALL_PLAN_BOOLS.push([channelActive, toolRows, forced, isMcp, isBuiltin, hasOrigCall, hasOrigResult]);

const p = (r: PlanRow, toolName = "zz_third") =>
	planResolverTakeover({
		channelActive: r[0], toolRowsEnabled: r[1], forced: r[2], isMcp: r[3], isBuiltin: r[4],
		hasOrigCall: r[5], hasOrigResult: r[6], toolName,
	});

test("channel gates: any off ⇒ undefined (resolver must return next() verbatim)", () => {
	for (const r of ALL_PLAN_BOOLS.filter((x) => !x[0] || !x[1])) {
		assert.equal(p(r), undefined, JSON.stringify(r));
	}
});

test("plan call/result slots: track the matrix per slot (builtin ours, MCP ours, yield/force/vacancy per slot)", () => {
	for (const r of ALL_PLAN_BOOLS.filter((x) => x[0] && x[1])) {
		const plan = p(r)!;
		const [, , forced, isMcp, isBuiltin, hasOrigCall, hasOrigResult] = r;
		const wantCall = d([true, true, forced, isMcp, isBuiltin, hasOrigCall], "call");
		const wantResult = d([true, true, forced, isMcp, isBuiltin, hasOrigResult], "result");
		assert.equal(plan.call, wantCall, JSON.stringify(r));
		assert.equal(plan.result, wantResult, JSON.stringify(r));
	}
});

test("DEC-05 shell: call=cc ⇒ self; call=orig ⇒ self for non-builtin (P1-1 yield-path flat shell), builtin+orig unreachable", () => {
	for (const r of ALL_PLAN_BOOLS.filter((x) => x[0] && x[1])) {
		const plan = p(r)!;
		const wantShell = plan.call === "cc" || !r[4] ? "self" : "orig";
		assert.equal(plan.shell, wantShell, JSON.stringify(r));
		// P1-1 regression pin: a definition-carrying third-party tool that
		// yields call+result in auto mode still gets the flat container —
		// exactly today's prototype-patch shell behavior.
	}
	const yieldRow: PlanRow = [true, true, false, false, false, true, true];
	assert.deepEqual(p(yieldRow), { call: "orig", result: "orig", shell: "self" }, "P1-1: yield path keeps flat shell");
	const builtinRow: PlanRow = [true, true, false, false, true, true, true];
	assert.deepEqual(p(builtinRow), { call: "cc", result: "cc", shell: "self" }, "builtin seven taken over in auto");
	const mcpRow: PlanRow = [true, true, false, true, false, true, true];
	assert.deepEqual(p(mcpRow), { call: "cc", result: "cc", shell: "self" }, "MCP always taken over");
	const vacantRow: PlanRow = [true, true, false, false, false, false, false];
	assert.deepEqual(p(vacantRow), { call: "cc", result: "cc", shell: "self" }, "renderer-less third-party taken over");
});

test("plan exempt tools: forced result yields for subagent/obs_recall, call stays ours", () => {
	for (const name of FORCE_RESULT_EXEMPT) {
		const r: PlanRow = [true, true, true, false, false, true, true];
		assert.deepEqual(p(r, name), { call: "cc", result: "orig", shell: "self" }, name);
	}
});

test("plan channel gates lose to nothing: rows on + channel active always yields a plan (definition guaranteed)", () => {
	// With the channel open a plan always exists — the resolver then returns
	// a merged object, so the component always has a definition (Δ4b
	// unregistered-tool coverage rides on this).
	for (const r of ALL_PLAN_BOOLS.filter((x) => x[0] && x[1])) {
		assert.notEqual(p(r), undefined, JSON.stringify(r));
	}
});
