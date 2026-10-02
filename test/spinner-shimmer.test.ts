/**
 * Shimmer sweep tests (CC Spinner.tsx computeShimmerSegments port): the
 * band is a narrow window that slides across the verb, splits it into
 * before/shimmer/after, fades in from offscreen (negative index), and
 * wraps after width + lead-in + trail-out. Pure table tests — no theme,
 * no timers.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	shimmerSegments,
	glimmerIndexAt,
	SPINNER_TICK_MS,
	SHIMMER_LEAD_IN,
	SHIMMER_TRAIL_OUT,
} from "../extensions/lib/spinner-shimmer.ts";

test("segments reassemble to the original text at every index", () => {
	const text = "Percolating…";
	for (let gi = -3; gi <= text.length + 4; gi++) {
		const seg = shimmerSegments(text, gi);
		assert.equal(seg.before + seg.shimmer + seg.after, text, `index ${gi}`);
	}
});

test("band splits the word mid-sweep", () => {
	// gi=5 → band covers columns 4..5 (start = gi-1, two columns wide)
	const seg = shimmerSegments("Baking…", 5);
	assert.equal(seg.before, "Baki");
	assert.equal(seg.shimmer.length, 3);
	assert.equal(seg.before + seg.shimmer + seg.after, "Baking…");
});

test("offscreen band renders no shimmer segment", () => {
	const text = "Vibing…";
	assert.deepEqual(shimmerSegments(text, -10), { before: text, shimmer: "", after: "" });
	assert.deepEqual(shimmerSegments(text, text.length + 10), { before: text, shimmer: "", after: "" });
});

test("glimmerIndexAt advances one column per SPINNER_TICK_MS and wraps", () => {
	const width = 8;
	const cycle = width + SHIMMER_LEAD_IN + SHIMMER_TRAIL_OUT;
	// Lead-in: negative index before entering the word.
	assert.equal(glimmerIndexAt(0, width), -SHIMMER_LEAD_IN);
	assert.equal(glimmerIndexAt(SPINNER_TICK_MS, width), -SHIMMER_LEAD_IN + 1);
	// Wraps after one full cycle.
	assert.equal(glimmerIndexAt(cycle * SPINNER_TICK_MS, width), -SHIMMER_LEAD_IN);
	assert.equal(glimmerIndexAt(cycle * SPINNER_TICK_MS + 2 * SPINNER_TICK_MS, width), -SHIMMER_LEAD_IN + 2);
	// Negative elapsed clamps to the cycle start.
	assert.equal(glimmerIndexAt(-999, width), -SHIMMER_LEAD_IN);
});
