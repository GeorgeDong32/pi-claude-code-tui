/**
 * CC subagent presentation drawing — the pure rendering side of the
 * presentation seam (spec/2026-10-05-cc-tui-subagent-presentation.md §4/§6).
 *
 * Consumes read-only presentation frames (mirrored in
 * subagent-presentation.ts) and produces text lines plus per-row layout
 * facts. No IO, no pi runtime, no task state: the upstream owner keeps
 * state, windowing, selection, and coverage; this module only decides how
 * pixels look. Width math goes through pi-tui's visible-width helpers so
 * CJK/emoji/ANSI/APC measure like the rest of the CC look.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	SubagentPresentationAgentRow,
	SubagentPresentationAsyncCounts,
	SubagentPresentationAsyncFrame,
	SubagentPresentationDrawResult,
	SubagentPresentationFleetFrame,
	SubagentPresentationNestedRow,
	SubagentPresentationTheme,
	SubagentPresentationWorkflowLaneRow,
	SubagentPresentationWorkflowPhaseRow,
} from "./subagent-presentation.ts";

/**
 * Agent identity → semantic theme color. FNV-1a over the identity string,
 * hashed into a palette of theme color names that read on dark and light.
 * Same mapping the accepted fork surface used, now owned here.
 */
const IDENTITY_COLORS = [
	"mdLink",
	"mdHeading",
	"syntaxFunction",
	"syntaxKeyword",
	"syntaxNumber",
	"syntaxType",
	"syntaxVariable",
	"customMessageLabel",
	"toolTitle",
	"thinkingMedium",
	"thinkingHigh",
	"mdQuote",
	"bashMode",
	"userMessageText",
	"mdCode",
	"syntaxOperator",
] as const;

export function subagentIdentityColor(identity: string): (typeof IDENTITY_COLORS)[number] {
	let hash = 2166136261;
	for (let index = 0; index < identity.length; index++) {
		hash ^= identity.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return IDENTITY_COLORS[(hash >>> 0) % IDENTITY_COLORS.length]!;
}

/** "8.1k" / "1.2M" — compact token counts for the right column. */
export function compactTokenCount(value: number): string {
	return value >= 1_000_000
		? `${(value / 1_000_000).toFixed(1)}M`
		: value >= 1_000
			? `${(value / 1_000).toFixed(1)}k`
			: `${Math.max(0, Math.round(value))}`;
}

/** "16s" — fleet elapsed, rounded, never negative. */
export function formatFleetElapsed(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function formatFleetTokens(count: number, window?: number, windowCount = 1): string {
	const compact = compactTokenCount;
	return window !== undefined
		? `↓ ${compact(window)} ${windowCount > 1 ? "Σ windows" : "window"} · ${compact(count)} spent`
		: `↓ ${compact(count)} tokens`;
}

/** Tree branch rows: indent + connector + single space, glyph right after. */
function treeBranch(depth: number, branch: string): string {
	return `${"    ".repeat(depth)}${branch} `;
}

/** The selection arrow takes over the glyph cell in place — a CC-style cursor. */
function rowGlyph(selected: boolean, glyph: string, theme: SubagentPresentationTheme): string {
	return selected ? theme.fg("accent", ">") : glyph;
}

function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = Math.max(0, width - rightWidth - 1);
	const leftClamped = truncateToWidth(left, maxLeftWidth);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
	return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width);
}

function frameDetailElapsed(row: { startedAt?: number; endedAt?: number; durationMs?: number; state: string }, now: number): string | undefined {
	const duration = row.state === "running" && row.startedAt !== undefined
		? now - row.startedAt
		: row.durationMs ?? (row.startedAt !== undefined && row.endedAt !== undefined ? row.endedAt - row.startedAt : undefined);
	return duration === undefined ? undefined : formatFleetElapsed(duration);
}

function nestedStatusGlyph(state: string, theme: SubagentPresentationTheme, thinking?: string): string {
	if (state === "running") return runningTone(theme, thinking)("●");
	if (state === "queued" || state === "pending" || state === "planned") return theme.fg("muted", "◦");
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed" || state === "rejected") return theme.fg("error", "✗");
	return theme.fg("warning", "■");
}

function runningTone(theme: SubagentPresentationTheme, thinking?: string): (text: string) => string {
	if (thinking && theme.getThinkingBorderColor) {
		const tone = theme.getThinkingBorderColor(thinking);
		if (tone) return tone;
	}
	return (text) => theme.fg("accent", text);
}

function laneRowGlyph(row: SubagentPresentationWorkflowLaneRow, theme: SubagentPresentationTheme): string {
	if (!row.kind) return nestedStatusGlyph(row.state, theme, row.thinking);
	const state = row.state;
	if (state === "pending") return theme.fg("muted", "◦");
	if (state === "running") return theme.fg("accent", "●");
	if (state === "done") return row.verdict === "pass" ? theme.fg("success", "✓") : row.verdict === "fail" ? theme.fg("error", "✗") : theme.fg("warning", "■");
	if (state === "error") return theme.fg("error", "✗");
	return theme.fg("warning", "■");
}

function laneRowStateLabel(row: SubagentPresentationWorkflowLaneRow, theme: SubagentPresentationTheme): string {
	const state = row.kind ? hostStepVerdictLabel(row.state, row.verdict) : row.state;
	if (state === "running") return row.kind ? theme.fg("accent", state) : runningTone(theme, row.thinking)(state);
	if (state === "pending" || state === "queued") return theme.fg("muted", state);
	if (state === "pass" || state === "complete" || state === "completed") return theme.fg("success", state === "pass" ? "pass" : "complete");
	if (state === "fail" || state === "failed" || state === "error") return theme.fg("error", state === "fail" ? "fail" : state);
	return theme.fg("warning", state);
}

function hostStepVerdictLabel(state: string, verdict?: string): string {
	if (state === "done") return verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "done";
	if (state === "running") return "running";
	if (state === "pending") return "pending";
	if (state === "error" || state === "cancelled") return state;
	return state;
}

function contextModeLabel(mode: string | undefined): string {
	if (mode === "fork") return "[fork]";
	if (mode === "fresh") return "[fresh]";
	if (mode === "mixed") return "[mixed]";
	return "";
}

function drawAgentRow(row: SubagentPresentationAgentRow, width: number, theme: SubagentPresentationTheme, now: number): { line: string; unclipped: string } {
	const type = row.agentIdentity;
	let label = row.label ?? "";
	if (label.length > 20) label = `${label.slice(0, 19)}…`;
	if (!label || label === type) label = "";
	const elapsed = now - (row.startedAt ?? now);
	const rightText = row.projectPane
		? `${row.projectPane.summary ?? "—"} · ${formatFleetElapsed(now - row.projectPane.refreshedAt)} ago`
		: row.workflowWrapperUsageOnChildren
			? "usage on child rows"
			: `${compactTokenCount(row.usage?.tokens ?? 0)}·${formatFleetElapsed(elapsed)}`;
	const left = row.branch
		? `${treeBranch(1, row.branch)}${rowGlyph(row.selected === true, "○", theme)} ${type}${label ? `  ${label}` : ""}`
		: `${row.selected === true ? theme.fg("accent", "> ") : "  "}○ ${type}${label ? `  ${label}` : ""}`;
	const right = theme.fg("dim", rightText);
	const unclipped = `${left} ${right}`;
	return { line: rightAlign(left, right, width), unclipped };
}

function drawLaneRow(row: SubagentPresentationWorkflowLaneRow, width: number, theme: SubagentPresentationTheme, now: number): { line: string; unclipped: string } {
	if (row.overflow !== undefined) {
		const line = truncateToWidth(`${treeBranch(1, row.branch)}${theme.fg("dim", `+${row.overflow} hidden workflow steps`)}`, width);
		return { line, unclipped: line };
	}
	const context = contextModeLabel(row.context);
	const modelThinking = row.modelThinking ? ` (${row.modelThinking})` : "";
	const activity = row.activity ? ` · ${row.activity}` : "";
	const kind = row.kind ? `${row.kind}: ` : "";
	const hints = row.preflight ? [
		row.preflight.mode ? `mode:${row.preflight.mode}` : undefined,
		row.preflight.decision ? `decision:${row.preflight.decision}` : undefined,
		row.preflight.claims?.length ? `claims:${row.preflight.claims.join(",")}` : undefined,
		row.preflight.expectedOutput ? `expected:${row.preflight.expectedOutput}` : undefined,
		row.preflight.independence ? `independence:${row.preflight.independence}` : undefined,
	].filter((value): value is string => Boolean(value)).join(" · ") : "";
	const left = `${treeBranch(1, row.branch)}${laneRowGlyph(row, theme)} ${theme.fg("muted", `${kind}${row.name}${context ? ` ${context}` : ""}${modelThinking}`)} · ${laneRowStateLabel(row, theme)}${activity}${hints ? ` · ${hints}` : ""}`;
	const details = [
		frameDetailElapsed(row, now),
		row.usage?.tokens !== undefined ? formatFleetTokens(row.usage.tokens, row.usage.window) : undefined,
		row.provider ? `provider:${row.provider}` : undefined,
		row.role ? `role:${row.role}` : undefined,
		row.target,
		row.detail,
		row.reasonCode ? `reason:${row.reasonCode}` : undefined,
		row.freshness?.stale ? "stale" : row.freshness?.observedRef ? `ref:${row.freshness.observedRef}` : undefined,
		row.reportPath ? `out:${reportName(row.reportPath)}` : undefined,
	].filter(Boolean).join(" · ");
	const unclipped = `${left}${details ? theme.fg("dim", ` · ${details}`) : ""}`;
	return { line: truncateToWidth(unclipped, width), unclipped };
}

function reportName(reportPath: string): string {
	const base = reportPath.split(/[/\\]/).filter(Boolean).pop() ?? reportPath;
	return base.length > 24 ? `${base.slice(0, 21)}…` : base;
}

function drawPhaseRow(row: SubagentPresentationWorkflowPhaseRow, width: number, theme: SubagentPresentationTheme): { line: string; unclipped: string } {
	const glyph = row.state === "complete"
		? theme.fg("success", "✓")
		: row.state === "running"
			? runningTone(theme)("●")
			: row.state === "blocked" || row.state === "failed"
				? theme.fg("error", row.state === "blocked" ? "!" : "✗")
				: row.state === "queued"
					? theme.fg("muted", "◦")
					: theme.fg("warning", "■");
	const unclipped = `${treeBranch(1, row.branch)}${glyph} ${theme.fg("muted", row.text)}`;
	return { line: truncateToWidth(unclipped, width), unclipped };
}

function drawNestedRow(row: SubagentPresentationNestedRow, width: number, theme: SubagentPresentationTheme, now: number): { line: string; unclipped: string } {
	if (row.overflow !== undefined) {
		const line = truncateToWidth(`${treeBranch(row.depth + 1, row.branch)}${theme.fg("dim", `+${row.overflow} nested leaves`)}`, width);
		return { line, unclipped: line };
	}
	const modelThinking = row.modelThinking ? ` (${row.modelThinking})` : "";
	const activity = row.activity ? ` · ${row.activity}` : "";
	const left = `${treeBranch(row.depth + 1, row.branch)}${nestedStatusGlyph(row.state, theme, row.thinking)} ${theme.fg(subagentIdentityColor(row.agentIdentity ?? row.name), `${row.name}${modelThinking}`)} · ${row.state}${activity}`;
	const elapsed = frameDetailElapsed(row, now);
	const tokens = row.usage?.tokens !== undefined ? ` · ${compactTokenCount(row.usage.tokens)} tok` : "";
	const unclipped = `${left}${elapsed !== undefined ? theme.fg("dim", ` · ${elapsed}`) : ""}${theme.fg("dim", tokens)}`;
	return { line: truncateToWidth(unclipped, width), unclipped };
}

/**
 * The CC fleet roster drawing. Produces the accepted CC look (solid main
 * marker, hollow agents, explicit tree branches, compact token·time right
 * column, selection arrow in place) and reports layout facts — including
 * per-row truncation — from the same pass the upstream coverage decision
 * consumes.
 */
export function drawCcFleetFrame(frame: SubagentPresentationFleetFrame): SubagentPresentationDrawResult {
	const theme = frame.theme;
	const lines: string[] = [];
	const layout: SubagentPresentationDrawResult["layout"] = [];
	const push = (rowKey: string, produced: string, unclipped = produced): void => {
		layout.push({ rowKey, fromLine: lines.length, toLine: lines.length, truncated: visibleWidth(unclipped) > frame.width });
		lines.push(produced);
	};
	for (const row of frame.rows) {
		switch (row.rowKind) {
			case "main":
				push(row.rowKey, truncateToWidth(`${row.selected === true ? theme.fg("accent", "> ") : "  "}● main`, frame.width));
				break;
			case "overflow":
				push(row.rowKey, rightAlign("", theme.fg("dim", `${row.direction === "above" ? "↑" : "↓"} ${row.hidden} more`), frame.width));
				break;
			case "agent": {
				const { line, unclipped } = drawAgentRow(row, frame.width, theme, frame.now);
				push(row.rowKey, line, unclipped);
				break;
			}
			case "workflow-lane": {
				const { line, unclipped } = drawLaneRow(row, frame.width, theme, frame.now);
				push(row.rowKey, line, unclipped);
				break;
			}
			case "workflow-phase": {
				const { line, unclipped } = drawPhaseRow(row, frame.width, theme);
				push(row.rowKey, line, unclipped);
				break;
			}
			case "nested": {
				const { line, unclipped } = drawNestedRow(row, frame.width, theme, frame.now);
				push(row.rowKey, line, unclipped);
				break;
			}
			case "section-header": {
				const from = lines.length;
				lines.push("", truncateToWidth(`  ${theme.fg("dim", row.text)}`, frame.width));
				layout.push({ rowKey: row.rowKey, fromLine: from, toLine: from + 1, truncated: false });
				break;
			}
		}
	}
	return { lines, layout };
}

// ---- CC async surface drawing (spec §4.4) ----

function ccAsyncGlyph(state: string, theme: SubagentPresentationTheme): string {
	if (state === "running") return theme.fg("accent", "●");
	if (state === "queued" || state === "pending") return theme.fg("muted", "◦");
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed" || state === "rejected") return theme.fg("error", "✗");
	return theme.fg("warning", "■");
}

function ccAsyncCountsLine(counts: SubagentPresentationAsyncCounts, theme: SubagentPresentationTheme): string {
	const hasActive = counts.running > 0 || counts.queued > 0;
	const parts: string[] = [];
	if (counts.running > 0) parts.push(`${counts.running}/${counts.total} running`);
	if (counts.queued > 0) parts.push(`${counts.queued} queued`);
	if (counts.failed > 0) parts.push(`${counts.failed} failed`);
	if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
	if (counts.paused > 0) parts.push(`${counts.paused} paused`);
	if (counts.partial > 0) parts.push(`${counts.partial} partial`);
	if (counts.rejected > 0) parts.push(`${counts.rejected} rejected`);
	if (!hasActive && counts.complete > 0) parts.push(`${counts.complete}/${counts.total} done`);
	const glyph = hasActive ? theme.fg("accent", "●") : theme.fg("muted", "○");
	return `${glyph} ${theme.fg("muted", "subagents")} ${theme.fg("dim", `(${parts.join(", ") || `${counts.total} total`})`)}`;
}

/**
 * The CC async surface drawing: the same visual language as the fleet roster —
 * status glyphs, dim detail rows, tree connectors, and the compact counts
 * line when collapsed. Detail rows arrive as pre-composed text material
 * (§5.2) from the owner's projection; layout facts follow the seam contract
 * (one entry per frame row, matching the owner's frameRowsOf accounting).
 */
export function drawCcAsyncFrame(frame: SubagentPresentationAsyncFrame): SubagentPresentationDrawResult {
	const theme = frame.theme;
	const lines: string[] = [];
	const layout: SubagentPresentationDrawResult["layout"] = [];
	const push = (rowKey: string, line: string): void => {
		layout.push({ rowKey, fromLine: lines.length, toLine: lines.length, truncated: false });
		lines.push(truncateToWidth(line, frame.width));
	};
	if (frame.tier === "single-line" || (frame.tier === "progressive" && !frame.jobs.length)) {
		push("async:summary", ccAsyncCountsLine(frame.counts, theme));
		return { lines, layout };
	}
	if (frame.multiHeader) {
		const glyph = frame.multiHeader.anyRunning ? theme.fg("accent", "●") : theme.fg("muted", "○");
		push("async:header", `${glyph} ${theme.fg("muted", "subagents · background")}`);
	}
	for (const [index, section] of frame.jobs.entries()) {
		const head = section.header;
		const last = index === frame.jobs.length - 1 && !frame.hidden;
		const branch = last ? "└─" : "├─";
		const continuation = last ? "   " : "│  ";
		if (head.titleLine !== undefined) {
			// Single-job layout: CC glyph + name header, then the detail rows
			// under the CC ⎿ gutter (no tree connectors).
			push(section.rowKey, `${ccAsyncGlyph(head.state, theme)} ${head.name}${head.stats ? ` ${theme.fg("dim", `· ${stripAnsiTail(head.stats)}`)}` : ""}`);
			if (head.summaryLine !== undefined) push(`${section.rowKey}:summary`, `${ccAsyncGlyph(head.state, theme)} ${theme.fg("muted", head.activity ?? head.state)}`);
		} else {
			// Multi-item layout: CC tree connectors over the owner-composed
			// head material (structure CC, material fidelity).
			push(section.rowKey, `${theme.fg("dim", branch)} ${head.itemHeadLine ?? ""}`);
		}
		for (const row of section.rows) {
			if (row.rowKind !== "detail") continue;
			const gutter = row.gutter && head.titleLine !== undefined ? "⎿  " : "";
			push(`${section.rowKey}:${row.rowKey}`, `${theme.fg("dim", continuation)}${gutter ? `  ${theme.fg("dim", gutter)}` : ""}${row.text}`);
		}
		for (const [childIndex, childLine] of (section.childrenLines ?? []).entries()) {
			push(`${section.rowKey}:child:${childIndex}`, `${theme.fg("dim", continuation)}${childLine}`);
		}
		if (section.childrenHidden) push(`${section.rowKey}:children-hidden`, `${theme.fg("dim", continuation)}  +${section.childrenHidden} more workflow children`);
	}
	if (frame.hidden) {
		const total = frame.hidden.running + frame.hidden.finished + (frame.hidden.queued ?? 0);
		if (total > 0) push("async:hidden", theme.fg("dim", `↓ ${total} more`));
	}
	return { lines, layout };
}

function stripAnsiTail(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
