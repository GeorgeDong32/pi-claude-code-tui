/** Plan SL1/D0: completion-line formatting + shared numeric formatters. */
import test from "node:test";
import assert from "node:assert/strict";

import { buildCompletionLine, formatCost, formatDuration, formatTokens } from "../extensions/lib/render-utils.ts";

test("formatDuration table", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(540), "1s"); // rounds to nearest second
	assert.equal(formatDuration(59_400), "59s");
	assert.equal(formatDuration(61_000), "1m 1s");
	assert.equal(formatDuration(90_000), "1m 30s");
	assert.equal(formatDuration(3_723_000), "62m 3s"); // no hour unit, minutes keep growing
});

test("formatTokens table", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_000), "1k");
	assert.equal(formatTokens(26_400), "26k");
	assert.equal(formatTokens(1_050_000), "1.1M");
});

test("formatCost keeps cent precision under $0.01", () => {
	assert.equal(formatCost(0.0072), "$0.0072");
	assert.equal(formatCost(0.04), "$0.04");
	assert.equal(formatCost(1.5), "$1.50");
});

test("buildCompletionLine: verb + duration + local HH:MM end time", () => {
	// Local-time Date constructor keeps both sides in the test's timezone.
	const end = new Date(2026, 8, 22, 13, 54, 5).getTime();
	assert.equal(buildCompletionLine("Baked", 81_000, end), "✻ Baked for 1m 21s · 13:54");
});

test("buildCompletionLine zero-pads small hours and minutes", () => {
	const end = new Date(2026, 0, 3, 1, 2, 0).getTime();
	assert.equal(buildCompletionLine("Cooked", 2_000, end), "✻ Cooked for 2s · 01:02");
});

test("buildCompletionLine is deterministic for identical inputs", () => {
	const end = new Date(2026, 8, 22, 23, 59, 0).getTime();
	assert.equal(buildCompletionLine("Brewed", 60_000, end), buildCompletionLine("Brewed", 60_000, end));
});
