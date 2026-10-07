import assert from "node:assert/strict";
import test from "node:test";

import {
	callArgsFor,
	displayToolName,
	obsRecallDisplayView,
	packedEventRows,
	type CCTheme,
} from "../extensions/lib/cc-rows.ts";

/**
 * obs_recall display shaping (user direction 2026-10-06): the result text is
 * a model protocol — first line `[obs_recall id=… offset=… next_offset=…
 * eof=…]`, second `[chunk_bytes=… chunk_lines=…; use next_offset to
 * continue]`. The CC row parses those two lines (text-shaped detection, no
 * details dependency — the safest source, always present when the pack
 * produced the page) and replaces them with ONE human header in the original
 * pack renderer's format, keeping the body verbatim. Non-matching results
 * pass through unchanged (honest fallback: errors, foreign shapes).
 */

const PROTOCOL_PAGE = [
	"[obs_recall id=obs_5caf95927c3a939296aa5f60 offset=0 next_offset=15872 eof=false]",
	"[chunk_bytes=15872 chunk_lines=241; use next_offset to continue]",
	"line one of the actual content",
	"line two",
].join("\n");

function resultWithText(text: string): { content: Array<{ type: string; text: string }> } {
	return { content: [{ type: "text", text }] };
}

test("obs_recall view: protocol header becomes one human line, body kept verbatim", () => {
	const view = obsRecallDisplayView(resultWithText(PROTOCOL_PAGE));
	assert.ok(view.header);
	assert.equal(view.header, "15.5KB · 241 lines · start→+15.5KB · more ▸");
	assert.equal(view.text.split("\n").slice(0, 3).join("\n"), [
		"15.5KB · 241 lines · start→+15.5KB · more ▸",
		"line one of the actual content",
		"line two",
	].join("\n"), "protocol lines are gone; header leads; body verbatim");
});

test("obs_recall view: eof page reads 'end ✓' with no more hint", () => {
	const view = obsRecallDisplayView(resultWithText([
		"[obs_recall id=obs_a1b2c3d4e5f6 offset=31744 next_offset=31744 eof=true]",
		"[chunk_bytes=4096 chunk_lines=12; use next_offset to continue]",
		"tail content",
	].join("\n")));
	assert.equal(view.header, "4.0KB · 12 lines · +31.0KB→+31.0KB · end ✓");
	assert.ok(!view.text.includes("[obs_recall"), view.text);
});

test("obs_recall view: continuation pages carry their offset window", () => {
	const view = obsRecallDisplayView(resultWithText([
		"[obs_recall id=obs_a1b2c3d4e5f6 offset=15872 next_offset=31744 eof=false]",
		"[chunk_bytes=15872 chunk_lines=250; use next_offset to continue]",
		"more content",
	].join("\n")));
	assert.equal(view.header, "15.5KB · 250 lines · +15.5KB→+31.0KB · more ▸");
});

test("obs_recall view: non-protocol results pass through unchanged (honest fallback)", () => {
	const foreign = resultWithText("[obs_recall id=oops]\nnot a pack page");
	const view = obsRecallDisplayView(foreign);
	assert.equal(view.header, null);
	assert.equal(view.text, "[obs_recall id=oops]\nnot a pack page");
	const error = obsRecallDisplayView({ content: [{ type: "text", text: "Error: observation not found" }] });
	assert.equal(error.header, null);
	assert.equal(error.text, "Error: observation not found");
});

test("obs_recall view: call row and display name stay the pinned single format", () => {
	assert.equal(displayToolName("obs_recall"), "Recall Observation");
	assert.equal(callArgsFor("obs_recall", { id: "obs_5caf95927c3a939296aa5f60", offset: 15872 }), "obs_5caf95927c3a · +15.5KB");
});


// ---- packed-event pseudo tool row ----

const theme: CCTheme = {
	fg: (_c, t) => t,
	bold: (t) => t,
};

test("packedEventRows: single and multi sites render as one CC-style tool row", () => {
	const single = packedEventRows(theme, [{ tool: "read", id: "obs_d2d080c18f1be74f1428df79", avoidedTokens: 12476 }], 80);
	assert.equal(single.length, 2);
	assert.match(single[0]!.replace(/\x1b\[[0-9;]*m/g, ""), /⏺ Observation Packed\(read · 12.5k tokens avoided\)/);
	assert.match(single[1]!.replace(/\x1b\[[0-9;]*m/g, ""), /⎿  obs_d2d080c18f1b… · recall via obs_recall/);
	const multi = packedEventRows(theme, [
		{ tool: "read", id: "obs_aaaaaaaaaaaaaaaa", avoidedTokens: 12476 },
		{ tool: "bash", id: "obs_bbbbbbbbbbbbbbbb", avoidedTokens: 4512 },
	], 80);
	assert.match(multi[0]!.replace(/\x1b\[[0-9;]*m/g, ""), /⏺ Observation Packed\(2 results · 17.0k tokens avoided\)/);
	assert.deepEqual(packedEventRows(theme, [], 80), []);
});

// ---------------------------------------------------------------------------
// P1-1 R3 (spec R-T2): structured `details` win over the text protocol.

const FULL_DETAILS = { id: "obs_5caf95927c3a939296aa5f60", offset: 0, bytes: 15872, lines: 241, nextOffset: 15872, eof: false };

test("R-T2: only details (text without protocol lines) → human header from details, body kept verbatim", () => {
	const view = obsRecallDisplayView({
		content: [{ type: "text", text: "line one\nline two" }],
		details: FULL_DETAILS,
	});
	assert.equal(view.header, "15.5KB · 241 lines · start→+15.5KB · more ▸");
	assert.equal(view.text, "15.5KB · 241 lines · start→+15.5KB · more ▸\nline one\nline two");
});

test("R-T2: details + protocol text → details win; only verifiably-protocol lines are removed", () => {
	const view = obsRecallDisplayView({
		content: [{ type: "text", text: PROTOCOL_PAGE }],
		details: { ...FULL_DETAILS, eof: true, nextOffset: 15872 },
	});
	assert.equal(view.header, "15.5KB · 241 lines · start→+15.5KB · end ✓");
	assert.ok(!view.text.includes("[obs_recall id="));
	assert.ok(!view.text.includes("[chunk_bytes="));
	assert.ok(view.text.includes("line one of the actual content"));
});

test("R-T2: details conflict with text → details are authoritative for the header", () => {
	const view = obsRecallDisplayView({
		content: [{ type: "text", text: PROTOCOL_PAGE }],
		details: { ...FULL_DETAILS, bytes: 999, lines: 7 },
	});
	assert.equal(view.header, "999B · 7 lines · start→+15.5KB · more ▸");
});

test("R-T2: partial/invalid details (bad numbers, missing eof, error pages) never fabricate a paging header", () => {
	const bad = [
		{ id: "obs_x", offset: 0, bytes: Number.NaN, lines: 1, nextOffset: 1, eof: false }, // NaN bytes
		{ id: "obs_x", offset: -1, bytes: 1, lines: 1, nextOffset: 1, eof: false }, // negative offset
		{ id: "obs_x", offset: 0, bytes: 1, lines: 1, nextOffset: 1, eof: "false" }, // eof not boolean
		{ id: "obs_x", offset: 0, bytes: 1 }, // partial
		{ id: "", offset: 0, bytes: 1, lines: 1, nextOffset: 1, eof: false }, // empty id
		{ id: "obs_x" }, // the error-result shape: details { id } only
	];
	for (const details of bad) {
		const view = obsRecallDisplayView({
			content: [{ type: "text", text: "Unknown observation id: obs_x (no ledger)" }],
			details,
		});
		assert.equal(view.header, null, `no header for details ${JSON.stringify(details)}`);
		assert.equal(view.text, "Unknown observation id: obs_x (no ledger)");
	}
});

test("R-T2: no details → text protocol regex path still works (unchanged behavior)", () => {
	const view = obsRecallDisplayView({ content: [{ type: "text", text: PROTOCOL_PAGE }] });
	assert.equal(view.header, "15.5KB · 241 lines · start→+15.5KB · more ▸");
});

test("R-T2: deep-frozen input renders (never mutated in place)", () => {
	const frozen = Object.freeze({
		content: Object.freeze([
			Object.freeze({ type: "text", text: PROTOCOL_PAGE }),
			Object.freeze({ type: "image", source: Object.freeze({ kind: "base64" }) }),
		]),
		details: Object.freeze(FULL_DETAILS),
	});
	const view = obsRecallDisplayView(frozen);
	assert.equal(view.header, "15.5KB · 241 lines · start→+15.5KB · more ▸");
	// Non-text content blocks are preserved by the entry's display rebuild
	// (this test pins the view itself; the rebuild is exercised in the
	// golden suite via callArgsFor wiring notes).
	assert.ok(Object.isFrozen(frozen));
});
