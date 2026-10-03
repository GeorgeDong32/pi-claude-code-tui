/**
 * Pure value formatters shared across the CC look: durations, token
 * counts, cost, model/effort labels, the turn-completion line. Layout math
 * lives with its only consumer (pi-startup-header.ts); spinner verbs live
 * in spinner-verbs.ts.
 */
export function formatCwd(cwd: string, home = process.env.HOME): string {
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/** "45s" / "1m 21s" — durations for the working/completion row. */
export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** 999 / 12k / 1.2M — token counts. */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format cost like CC: full precision under a cent, cents above (plan SL1/D0). */
export function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(4)}`;
}

/**
 * Turn-completion line (plan SL1/D0): verb + run duration + wall-clock end
 * time, e.g. `✻ Baked for 1m 21s · 13:54`. Rendered dim (CC grays the row
 * out once the run finishes); the verb is injected by the caller so the
 * function itself stays deterministic for golden tests.
 */
export function buildCompletionLine(verb: string, elapsedMs: number, endTs: number): string {
	const end = new Date(endTs);
	const hh = String(end.getHours()).padStart(2, "0");
	const mm = String(end.getMinutes()).padStart(2, "0");
	return `✻ ${verb} for ${formatDuration(elapsedMs)} · ${hh}:${mm}`;
}

/** Prefer `provider/id` when available (matches other pi extension examples). */
export function formatModelLabel(model: { provider?: string; id?: string } | null | undefined): string {
	if (!model?.id) return "Default model";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/**
 * CC effort symbols (Claude Code EffortIndicator): ○ low → ◐ medium → ● high
 * → ◉ max — visual weight from glyph fill, not color. pi has seven thinking
 * levels to CC's four, so they collapse onto the nearest CC rung:
 * minimal/low → ○, medium → ◐, high/xhigh → ●, max → ◉. Unknown levels fall
 * back to ● (same defensive default as CC's effortLevelToSymbol).
 */
export function effortBadgeSymbol(level: string): string {
	switch (level) {
		case "minimal":
		case "low":
			return "\u25cb"; // ○
		case "medium":
			return "\u25d0"; // ◐
		case "max":
			return "\u25c9"; // ◉
		default:
			return "\u25cf"; // ● (high, xhigh, unknown)
	}
}
