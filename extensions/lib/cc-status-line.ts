/**
 * cc-status row composition (extracted 2026-10-03 from the entry factory).
 *
 * Three pure pieces that used to live as closures inside setStatusWidget /
 * footerLineText — untestable through the factory, only manually
 * verifiable:
 * - buildStatusRightGroup: the `model·effort │ Ctx p% (used/win) │ cost`
 *   right group (SL4/D4: collapses entirely when the statusline owns it)
 * - statusRowLayout: the left/right join with narrow-width degradation
 * - permissionModeLabel: the footer's mode chip (DC1: icon/label
 *   single-sourced from core's MODE_META via the bus projection)
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCost, formatTokens } from "./format.ts";

export interface StatusRightInput {
	model: string;
	/** Thinking effort appended to the model label (omitted when off). */
	effort?: string;
	used: number;
	contextWindow: number;
	cost: number;
	muted: (s: string) => string;
	dim: (s: string) => string;
	sep: string;
}

/** Right-aligned `model·effort │ Ctx p% (used/win) │ cost` group. */
export const buildStatusRightGroup = (i: StatusRightInput): string => {
	const modelLabel = i.effort ? `${i.model}·${i.effort}` : i.model;
	const rightParts = [i.muted(modelLabel)];
	if (i.contextWindow > 0 && i.used > 0) {
		const pct = Math.min(100, Math.round((i.used / i.contextWindow) * 100));
		rightParts.push(
			`${i.dim("Ctx ")}${i.muted(`${pct}%`)}${i.dim(`(${formatTokens(i.used)}/${formatTokens(i.contextWindow)})`)}`,
		);
	}
	if (i.cost > 0) {
		rightParts.push(i.muted(formatCost(i.cost)));
	}
	return rightParts.join(i.sep);
};

/**
 * Left/right status row: right-aligned when both fit (min 2-space gap),
 * plain left truncation when the right group is empty, and a 2-space
 * squeeze (truncated) when they cannot fit side by side.
 */
export const statusRowLayout = (left: string, right: string, width: number): string[] => {
	const leftW = visibleWidth(left);
	if (right === "") return [truncateToWidth(left, width)];
	const rightW = visibleWidth(right);
	if (leftW + rightW + 2 <= width) {
		const pad = " ".repeat(Math.max(2, width - leftW - rightW));
		return [truncateToWidth(`${left}${pad}${right}`, width)];
	}
	return [truncateToWidth(`${left}  ${right}`, width)];
};

export interface PmModeMetaLike {
	icon: string;
	label: string;
}

/**
 * Footer mode chip, e.g. `◐ plan mode on (shift+tab to cycle)`.
 * `mode` is the merged mode key (bus snapshot mode, env-var fallback);
 * `meta` is core's MODE_META projection (absent on older cores — bare mode
 * key + local paint is the fallback). `paintFor` maps mode → color paint
 * (entry's PM_MODE_PAINT); `gray` renders the cycle hint.
 */
export const permissionModeLabel = (
	mode: string | undefined,
	meta: Readonly<Record<string, PmModeMetaLike>> | undefined,
	paintFor: (mode: string) => (s: string) => string,
	gray: (s: string) => string,
): string => {
	if (!mode) return "";
	const paint = paintFor(mode);
	const m = meta?.[mode];
	const icon = m?.icon ?? "●";
	const label = m ? `${m.label.toLowerCase()} mode` : `${mode} mode`;
	return `${paint(`${icon} ${label} on`)}${gray(" (shift+tab to cycle)")}`;
};

// ── P1-2 step 1 (spec U1): cost / ctx% must appear exactly once ────────────

/** A full core money segment, e.g. `$0.012` / `$1.50` / `$0` (decimals incl. 0). */
const MONEY_SEGMENT = /^\$\d+(?:\.\d+)?$/;
/** A full core context segment, e.g. `3% ctx` / `0% ctx`. */
const CTX_SEGMENT = /^\d+(?:\.\d+)?% ctx$/;

/**
 * Remove the cost and ctx% segments from a core workingStats string so the
 * number is not shown twice (U1: the cctui right group / statusline script
 * row owns it). ONLY complete numeric segments are dropped — by " · " split,
 * full-segment match — so unknown text the user's core version may add
 * survives, and a loose `$` prefix can never eat prose. Everything else
 * (↑ / ↓ / R cache / ⚡ tok/s) is kept: cctui has no replacement for those.
 */
export const stripDuplicateStats = (pmStats: string): string =>
	pmStats
		.split(" · ")
		.filter((segment) => segment.length > 0 && !MONEY_SEGMENT.test(segment) && !CTX_SEGMENT.test(segment))
		.join(" · ");
