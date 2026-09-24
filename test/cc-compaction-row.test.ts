/**
 * Compaction row patch tests: the native [compaction] box must render as
 * one CC-style "⏺ Context compacted from N tokens" line, with the summary
 * expanding under the ⎿ gutter. keyText() returns "" outside a host
 * session, so the expand hint falls back to "(ctrl+o to expand)".
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CompactionSummaryMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { patchCompactionRow } from "../extensions/lib/cc-compaction-row.ts";

// The Box base class reads the global theme during render; init a default.
initTheme(undefined as unknown as string);

const fg = (_color: string, text: string) => text;
patchCompactionRow(() => fg);

const message = {
	role: "compactionSummary",
	summary: "The user greeted the agent.\nWork on the decoder started.",
	tokensBefore: 145234,
	timestamp: 0,
} as never;

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

function renderPlain(component: { render(width: number): string[] }): string[] {
	return component.render(100).map(strip);
}

test("collapsed compaction renders the single CC-style line", () => {
	const component = new CompactionSummaryMessageComponent(message);
	const lines = renderPlain(component);
	assert.ok(lines.some((l) => l.includes("⏺ Context compacted from 145,234 tokens")));
	assert.ok(lines.some((l) => l.includes("(ctrl+o to expand)")));
	assert.ok(!lines.some((l) => l.includes("The user greeted")));
});

test("expanded compaction shows the summary under the ⎿ gutter", () => {
	const component = new CompactionSummaryMessageComponent(message);
	(component as unknown as { setExpanded(e: boolean): void }).setExpanded(true);
	const lines = renderPlain(component);
	assert.ok(lines.some((l) => l.includes("Context compacted") && l.includes("145,234")));
	assert.ok(lines.some((l) => l.includes("⎿") && l.includes("The user greeted the agent.")));
	assert.ok(lines.some((l) => l.includes("⎿") && l.includes("Work on the decoder started.")));
});

test("fg fallback keeps the line readable when no theme is cached", () => {
	patchCompactionRow(() => null);
	const component = new CompactionSummaryMessageComponent(message);
	const lines = renderPlain(component);
	assert.ok(lines.some((l) => l.includes("Context compacted from 145,234 tokens")));
});
