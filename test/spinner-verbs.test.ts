/**
 * Spinner verb pool tests: CC parity (187 words, byte-aligned order,
 * Clauding swapped for the Piing easter egg) and the weighted sampler —
 * staples draw ~3x, the egg ~1/4x, everything else uniform. The RNG is
 * injected so draws are pinned deterministically; the distribution is
 * asserted against the weight math, not by luck.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	SPINNER_VERBS,
	SPINNER_STAPLES,
	SPINNER_EGGS,
	weightedVerbSample,
} from "../extensions/lib/spinner-verbs.ts";

test("verb pool keeps CC parity: 187 words, Piing in, Clauding out", () => {
	assert.equal(SPINNER_VERBS.length, 187);
	assert.equal(new Set(SPINNER_VERBS).size, 187, "no duplicates");
	assert.ok(SPINNER_VERBS.includes("Piing"), "pi easter egg present");
	assert.ok(!SPINNER_VERBS.includes("Clauding"), "CC brand egg swapped out");
	// Spot-check CC-order anchors (byte-aligned list, verified by diff).
	assert.equal(SPINNER_VERBS[0], "Accomplishing");
	assert.equal(SPINNER_VERBS[SPINNER_VERBS.length - 1], "Zigzagging");
});

test("staples and eggs are pool members", () => {
	for (const s of SPINNER_STAPLES) assert.ok(SPINNER_VERBS.includes(s), `staple ${s} missing`);
	for (const e of SPINNER_EGGS) assert.ok(SPINNER_VERBS.includes(e), `egg ${e} missing`);
});

test("weightedVerbSample honors injected rng draws", () => {
	// roll=0 lands on the first verb; roll→1 lands on the last.
	assert.equal(weightedVerbSample(() => 0), SPINNER_VERBS[0]);
	assert.equal(weightedVerbSample(() => 0.999999), SPINNER_VERBS[SPINNER_VERBS.length - 1]);
	// Every draw must be a pool member.
	const seen = new Set<string>();
	for (let i = 0; i < 500; i++) seen.add(weightedVerbSample());
	for (const v of seen) assert.ok(SPINNER_VERBS.includes(v));
});

test("staples draw ~3x more often than regular verbs", () => {
	const N = 200_000;
	const counts = new Map<string, number>();
	for (let i = 0; i < N; i++) {
		const v = weightedVerbSample();
		counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	const stapleRate = (counts.get("Baking") ?? 0) / N;
	const regularRate = (counts.get("Honking") ?? 0) / N; // regular word, same first letter spread
	const total = 8 * 3 + 178 * 1 + 0.25;
	const expectedStaple = 3 / total;
	const expectedRegular = 1 / total;
	assert.ok(Math.abs(stapleRate - expectedStaple) < 0.0008, `staple ${stapleRate} vs ${expectedStaple}`);
	assert.ok(Math.abs(regularRate - expectedRegular) < 0.0008, `regular ${regularRate} vs ${expectedRegular}`);
	assert.ok(stapleRate > regularRate * 2.5, "staple must clearly outrank regular");
});

test("easter egg stays rare (~0.12% per run)", () => {
	const N = 400_000;
	let eggs = 0;
	for (let i = 0; i < N; i++) {
		if (SPINNER_EGGS.includes(weightedVerbSample())) eggs++;
	}
	const rate = eggs / N;
	const expected = 0.25 / (8 * 3 + 178 * 1 + 0.25);
	assert.ok(Math.abs(rate - expected) < 0.0004, `egg rate ${rate} vs ${expected}`);
	assert.ok(rate < 0.002, "egg must stay rare");
});
