import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Logo half is the hero (Claude Code style): it takes most of the width and
 * grows on wide terminals so the mark stays centered in a large left area.
 * Tips are a narrow right sidebar that truncates with an ellipsis.
 */
/** Narrowest left column that still fits the animated logo (8×3 cells). */
export const MIN_LEFT_WIDTH = 28;
/** Narrowest tips sidebar; below this, tips are hidden. */
export const MIN_TIPS_WIDTH = 16;
/** Cap tips so they never steal the logo half on wide terminals. */
export const MAX_TIPS_WIDTH = 28;
const COLUMN_GAP = 3; // ` ${divider} `
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

export function formatThinkingLabel(level: string): string {
	return level === "off" ? "off" : level;
}

/** Claude-style gerunds used while Pi is generating a response. */
export const PI_WORKING_VERBS = [
	"Accomplishing",
	"Acting",
	"Adapting",
	"Analyzing",
	"Architecting",
	"Arranging",
	"Assembling",
	"Assessing",
	"Auditing",
	"Balancing",
	"Baking",
	"Benchmarking",
	"Boogieing",
	"Brewing",
	"Bridging",
	"Calculating",
	"Calibrating",
	"Charting",
	"Checking",
	"Cerebrating",
	"Channelling",
	"Churning",
	"Choreographing",
	"Circling",
	"Clarifying",
	"Coalescing",
	"Cogitating",
	"Combobulating",
	"Compiling",
	"Composing",
	"Computing",
	"Conceiving",
	"Concocting",
	"Considering",
	"Contemplating",
	"Cooking",
	"Coordinating",
	"Crafting",
	"Creating",
	"Curating",
	"Deciphering",
	"Debugging",
	"Deliberating",
	"Delving",
	"Designing",
	"Detecting",
	"Discerning",
	"Dreaming",
	"Engineering",
	"Envisioning",
	"Evaluating",
	"Examining",
	"Exploring",
	"Fermenting",
	"Finagling",
	"Formulating",
	"Forging",
	"Generating",
	"Grappling",
	"Harmonizing",
	"Hatching",
	"Ideating",
	"Imagining",
	"Improvising",
	"Investigating",
	"Iterating",
	"Jamming",
	"Juggling",
	"Manifesting",
	"Marinating",
	"Mapping",
	"Mulling",
	"Noodling",
	"Orchestrating",
	"Organizing",
	"Pondering",
	"Polishing",
	"Probing",
	"Processing",
	"Puzzling",
	"Reasoning",
	"Reflecting",
	"Refactoring",
	"Researching",
	"Ruminating",
	"Scaffolding",
	"Scheming",
	"Searching",
	"Shaping",
	"Sketching",
	"Sleuthing",
	"Solving",
	"Spelunking",
	"Spinning",
	"Strategizing",
	"Synthesizing",
	"Thinking",
	"Tinkering",
	"Tracing",
	"Unraveling",
	"Validating",
	"Visualizing",
	"Vibing",
	"Wandering",
	"Whirring",
	"Wibbling",
	"Wielding",
	"Wondering",
	"Wrangling",
	"Writing",
] as const;

/** Pick a new working verb, avoiding the same verb twice in a row. */
export function pickWorkingVerb(previous?: string, random = Math.random): string {
	const value = Math.max(0, Math.min(0.999999999, random()));
	let index = Math.floor(value * PI_WORKING_VERBS.length);
	let verb = PI_WORKING_VERBS[index] ?? PI_WORKING_VERBS[0];
	if (verb === previous) {
		index = (index + 1) % PI_WORKING_VERBS.length;
		verb = PI_WORKING_VERBS[index]!;
	}
	return verb;
}

/**
 * Built-in interactive slash command names (from pi's BUILTIN_SLASH_COMMANDS).
 * `pi.getCommands()` only returns extension/prompt/skill commands, so we keep
 * this list to surface real host commands in tips.
 */
export const PI_BUILTIN_SLASH_COMMAND_NAMES = [
	"settings",
	"model",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
] as const;

/**
 * Build tip lines: always include `fixed` (default `/use-default-tui`), then
 * `count` random picks from the available command pool.
 * Returns slash-prefixed names, e.g. `["/use-default-tui", "/model", ...]`.
 */
export function pickSlashCommandTips(
	availableNames: readonly string[],
	options: {
		fixed?: readonly string[];
		count?: number;
		exclude?: readonly string[];
		/** Injected RNG in [0, 1) for tests. */
		random?: () => number;
	} = {},
): string[] {
	const fixed = [...(options.fixed ?? ["use-default-tui"])];
	const count = options.count ?? 3;
	const exclude = new Set<string>([
		...(options.exclude ?? []),
		...fixed,
		// Don't advertise re-enabling this package look in the tips list.
		"use-claude-code-tui",
	]);
	const random = options.random ?? Math.random;

	const pool = [...new Set(availableNames.map((n) => n.trim()).filter(Boolean))].filter(
		(name) => !exclude.has(name),
	);

	// Partial Fisher–Yates for `count` samples without bias.
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const tmp = pool[i]!;
		pool[i] = pool[j]!;
		pool[j] = tmp;
	}

	const picked = pool.slice(0, Math.max(0, count));
	return [...fixed, ...picked].map((name) => (name.startsWith("/") ? name : `/${name}`));
}

/** Collect host builtins + session commands from `pi.getCommands()`. */
export function collectPiCommandNames(sessionCommands: readonly { name: string }[]): string[] {
	const names = new Set<string>(PI_BUILTIN_SLASH_COMMAND_NAMES);
	for (const command of sessionCommands) {
		if (command.name) names.add(command.name);
	}
	return [...names];
}

export function center(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…");
	return `${" ".repeat(Math.floor((width - w) / 2))}${text}`;
}

export function padRight(text: string, width: number, ellipsis = ""): string {
	const clipped = truncateToWidth(text, width, ellipsis);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * Layout widths for the startup header body (Claude Code proportions).
 *
 * - Tips sidebar ≈ 28% of width, clamped to [MIN_TIPS_WIDTH, MAX_TIPS_WIDTH].
 * - Left (logo) gets the rest and stays the wider half.
 * - Narrow: hide tips and give the left column the full inner width.
 */
export function headerColumnWidths(
	innerWidth: number,
	minTipsWidth = MIN_TIPS_WIDTH,
	maxTipsWidth = MAX_TIPS_WIDTH,
	minLeftWidth = MIN_LEFT_WIDTH,
): { leftWidth: number; rightWidth: number; useTips: boolean } {
	if (innerWidth <= 0) {
		return { leftWidth: 0, rightWidth: 0, useTips: false };
	}

	const gap = COLUMN_GAP;
	if (innerWidth < minLeftWidth + gap + minTipsWidth) {
		return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
	}

	// Narrow tips sidebar; logo half absorbs the remaining width.
	let rightWidth = Math.min(maxTipsWidth, Math.max(minTipsWidth, Math.round(innerWidth * 0.28)));
	let leftWidth = innerWidth - gap - rightWidth;

	if (leftWidth < minLeftWidth) {
		leftWidth = minLeftWidth;
		rightWidth = innerWidth - gap - leftWidth;
	}

	// Keep logo half strictly wider than tips (Claude Code feel).
	if (leftWidth <= rightWidth) {
		leftWidth = Math.ceil((innerWidth - gap) * 0.65);
		rightWidth = innerWidth - gap - leftWidth;
	}

	if (rightWidth < minTipsWidth || leftWidth < minLeftWidth) {
		return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
	}

	return { leftWidth, rightWidth, useTips: true };
}
