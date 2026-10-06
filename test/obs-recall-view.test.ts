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
