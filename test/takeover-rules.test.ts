/**
 * Takeover matrix tests: every combination of the decision inputs, pinned
 * per slot. This is the safety net for the three inline condition chains
 * that used to live inside the prototype patch (call/result/renderShell) —
 * review fixes edf4fce (MCP exception scope) and eb4dc7c (obs_recall
 * exemption) were bugs in exactly this matrix.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decideTakeover, FORCE_RESULT_EXEMPT } from "../extensions/lib/takeover-rules.ts";

type Row = [boolean, boolean, boolean, boolean, boolean, boolean];

const ALL_BOOLS: Row[] = [];
for (const enabled of [false, true])
	for (const toolRows of [false, true])
		for (const forced of [false, true])
			for (const isMcp of [false, true])
				for (const isBuiltin of [false, true])
					for (const hasOrig of [false, true]) ALL_BOOLS.push([enabled, toolRows, forced, isMcp, isBuiltin, hasOrig]);

const d = (r: Row, slot: "call" | "result" | "shell", toolName = "zz_third") =>
	decideTakeover({
		enabled: r[0], toolRowsEnabled: r[1], forced: r[2], isMcp: r[3], isBuiltin: r[4], hasOrig: r[5],
		toolName, slot,
	});

test("user switches gate everything — any off ⇒ orig on every slot", () => {
	for (const r of ALL_BOOLS.filter((x) => !x[0] || !x[1])) {
		assert.equal(d(r, "call"), "orig", JSON.stringify(r));
		assert.equal(d(r, "result"), "orig", JSON.stringify(r));
		assert.equal(d(r, "shell"), "orig", JSON.stringify(r));
	}
});

test("call slot: MCP always ours; builtin never via prototype; third-party by force or vacancy", () => {
	for (const r of ALL_BOOLS.filter((x) => x[0] && x[1])) {
		const [, , forced, isMcp, isBuiltin, hasOrig] = r;
		const got = d(r, "call");
		let want: "orig" | "cc";
		if (isMcp) want = "cc";
		else if (isBuiltin) want = "orig";
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

test("shell slot: flat container only for definition-carrying third-party/MCP tools", () => {
	for (const r of ALL_BOOLS.filter((x) => x[0] && x[1])) {
		const [, , , isMcp, isBuiltin, hasOrig] = r;
		const got = d(r, "shell");
		const want = (isMcp || !isBuiltin) && hasOrig ? "cc" : "orig";
		assert.equal(got, want, JSON.stringify(r));
	}
});

test("edf4fce regression: MCP exception exempts only builtin-check + auto-yield, never the user switches", () => {
	// An MCP tool with its own renderer stays ours even in AUTO mode…
	assert.equal(d([true, true, false, true, false, true], "call"), "cc");
	// …but the user turning tool rows off always wins over the MCP exception.
	assert.equal(d([true, false, true, true, false, true], "call"), "orig");
	assert.equal(d([false, true, true, true, false, true], "call"), "orig");
});
