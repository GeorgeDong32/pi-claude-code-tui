/**
 * Shimmer sweep for the spinner verb (2026-10-02).
 *
 * CC keeps one verb per run but never lets it sit still: a narrow light
 * band sweeps across the word (Spinner.tsx `computeShimmerSegments` —
 * before/shimmer/after split, `shimmerColor` band, index advanced by
 * SHIMMER_INTERVAL_MS and wrapping at word width). This module ports that
 * as pure functions: the render site paints `before`/`after` with the
 * spinner accent and the `shimmer` band with the theme's brighter
 * `borderAccent` (claudeShimmer), both read lazily per frame.
 *
 * The band rides the existing 200ms spinner tick (no new timer — repo
 * rule: timers are unref'd and sparse), so it advances one column per
 * 200ms with a short lead-in/lead-out margin before wrapping.
 */

/** Light band width in columns (CC: shimmerStart = index-1 .. index+1). */
export const SHIMMER_BAND = 2;
/** Lead-in columns before column 0 (band fades in from offscreen). */
export const SHIMMER_LEAD_IN = 2;
/** Trail columns after the last column (band fades out offscreen). */
export const SHIMMER_TRAIL_OUT = 4;
/** Shared spinner tick (ms): drives BOTH the blossom frame advance and the
 * shimmer band step. Single source so they can never drift apart.
 * 200ms is the settled cadence (CC native is 120ms — busier); a 300ms
 * trial read as sluggish next to the shimmer sweep and was rolled back. */
export const SPINNER_TICK_MS = 200;

export interface ShimmerSegments {
	before: string;
	shimmer: string;
	after: string;
}

/** Split `text` (ASCII-safe spinner verbs + "…") into three segments around
 * the light band at `glimmerIndex` (start column, may be negative). */
export function shimmerSegments(text: string, glimmerIndex: number): ShimmerSegments {
	const width = text.length;
	const start = Math.max(0, glimmerIndex - 1);
	const end = Math.min(width, glimmerIndex - 1 + SHIMMER_BAND + 1);
	if (start >= width || end <= 0) return { before: text, shimmer: "", after: "" };
	return {
		before: text.slice(0, start),
		shimmer: text.slice(start, end),
		after: text.slice(end),
	};
}

/** Band position for an elapsed run: advances one column per
 * SPINNER_TICK_MS, wraps after width + lead-in + trail-out. */
export function glimmerIndexAt(elapsedMs: number, width: number): number {
	const cycle = width + SHIMMER_LEAD_IN + SHIMMER_TRAIL_OUT;
	const step = Math.floor(Math.max(0, elapsedMs) / SPINNER_TICK_MS) % cycle;
	return step - SHIMMER_LEAD_IN;
}
