import assert from "node:assert/strict";
import test from "node:test";

import {
	callArgsFor,
	displayToolName,
	obsRecallDisplayView,
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

// ---- packed large-result shaping ----

import { obsPackedDisplayView } from "../extensions/lib/cc-rows.ts";

function placeholderText(opts: { id: string; tool: string; bytes: number; lines: number; tokens: number }): string {
	return [
		"[large tool result replaced after its first 2 provider requests]",
		`id: ${opts.id}`,
		`tool: ${opts.tool}`,
		`original_bytes: ${opts.bytes}`,
		`original_lines: ${opts.lines}`,
		`estimated_tokens: ${opts.tokens}`,
		`retrieve: call obs_recall with {"id":"${opts.id}","offset":0}; continue with returned next_offset`,
		"[first complete lines, up to 128 bytes]",
		"alpha line",
		"beta line",
		"[middle omitted; last complete lines, up to 128 bytes]",
		"omega line",
		"[52800 original bytes omitted]",
	].join("\n");
}

test("packed view: protocol header becomes one CC-style line, excerpts kept", () => {
	const text = placeholderText({ id: "obs_5caf95927c3a939296aa5f60", tool: "read", bytes: 52800, lines: 582, tokens: 12796 });
	const view = obsPackedDisplayView({ content: [{ type: "text", text }] }, () => 12796);
	assert.equal(view.header, "⚡ packed after 2 sends · 12.8k context tokens avoided · 51.6KB · 582 lines · recall: obs_recall");
	assert.equal(view.text, [
		"⚡ packed after 2 sends · 12.8k context tokens avoided · 51.6KB · 582 lines · recall: obs_recall",
		"alpha line",
		"beta line",
		"⋯ omitted ⋯",
		"omega line",
	].join("\n"), view.text);
});

test("packed view: exact registry value replaces the estimate (no ~ marker)", () => {
	const text = placeholderText({ id: "obs_aaaa", tool: "bash", bytes: 900, lines: 9, tokens: 200 });
	const est = obsPackedDisplayView({ content: [{ type: "text", text }] });
	assert.match(est.header!, /~200 context tokens/);
	const exact = obsPackedDisplayView({ content: [{ type: "text", text }] }, () => 151);
	assert.match(exact.header!, /(?<!~)151 context tokens/);
	assert.ok(!exact.header!.includes("~151"));
});

test("packed view: non-placeholder results pass through unchanged", () => {
	const foreign = "just a normal multi\nline tool result\nwith no pack protocol";
	const view = obsPackedDisplayView({ content: [{ type: "text", text: foreign }] });
	assert.equal(view.header, null);
	assert.equal(view.text, foreign);
	const short = "[large tool result replaced after its first 2 provider requests]";
	const truncated = obsPackedDisplayView({ content: [{ type: "text", text: short }] });
	assert.equal(truncated.header, null, "lone header line without the full protocol is not a page");
});
