import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { readEffortLevel } from "./host-status.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCwd, formatModelLabel } from "./format.ts";

const LOGO_CELL = "███";
const LOGO_ANIMATION_INTERVAL_MS = 120;

type LogoColor = "panel" | "cyan" | "red" | "green" | "orange" | "white" | "flash" | "brand";
type LogoFrame = {
	phase: number;
	active: "left" | "top" | "right" | "none";
	ax: number;
	ay: number;
	flash: boolean;
	white: boolean;
};

const LOGO_FRAMES: LogoFrame[] = [
	...Array.from({ length: 4 }, (_, ay) => ({ phase: 0, active: "left" as const, ax: 2, ay, flash: false, white: false })),
	...Array.from({ length: 3 }, (_, ay) => ({ phase: 1, active: "top" as const, ax: 2, ay, flash: false, white: false })),
	...Array.from({ length: 5 }, (_, ay) => ({ phase: 2, active: "right" as const, ax: 5, ay, flash: false, white: false })),
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
	{ phase: 4, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
	{ phase: 6, active: "none", ax: 0, ay: 0, flash: false, white: false },
];

const colorCell = (color: LogoColor, paintBrand: (text: string) => string): string => {
	switch (color) {
		case "cyan":
			return `\x1b[36m${LOGO_CELL}\x1b[39m`;
		case "red":
			return `\x1b[31m${LOGO_CELL}\x1b[39m`;
		case "green":
			return `\x1b[32m${LOGO_CELL}\x1b[39m`;
		case "orange":
		case "flash":
			return `\x1b[33m${LOGO_CELL}\x1b[39m`;
		case "white":
			return `\x1b[39m${LOGO_CELL}`;
		case "brand":
			return paintBrand(LOGO_CELL);
		default:
			return " ".repeat(LOGO_CELL.length);
	}
};

function hasCell(y: number, x: number, cells: string): boolean {
	return cells.split(" ").includes(`${y},${x}`);
}

function hasPiece(y: number, x: number, py: number, px: number, cells: string): boolean {
	return cells.split(" ").some((item) => {
		const [dy, dx] = item.split(",").map(Number);
		return y === py + dy && x === px + dx;
	});
}

function logoCellColor(frame: LogoFrame, y: number, x: number): LogoColor {
	if (frame.white) {
		return hasCell(y, x, "3,2 3,3 3,4 4,2 4,4 5,2 5,3 5,5 6,2 6,5") ? "white" : "panel";
	}
	if (frame.flash && y === 6 && x >= 1 && x <= 6) return "flash";

	switch (frame.active) {
		case "left":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 1,1 2,0")) return "red";
			break;
		case "top":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 0,1 0,2 1,2")) return "cyan";
			break;
		case "right":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 2,0 2,1")) return "green";
			break;
	}

	if (frame.phase === 6) {
		return hasCell(y, x, "3,2 3,3 3,4 4,4 4,2 5,2 5,3 5,5 6,2 6,5") ? "brand" : "panel";
	}

	if (frame.phase === 4) {
		if (hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
		if (hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
		if (hasCell(y, x, "4,5 5,5")) return "green";
		return "panel";
	}

	if (frame.phase >= 5) {
		if (hasCell(y, x, "3,2 3,3 3,4 4,4")) return "cyan";
		if (hasCell(y, x, "4,2 5,2 5,3 6,2")) return "red";
		if (hasCell(y, x, "5,5 6,5")) return "green";
		return "panel";
	}

	if (frame.phase <= 3 && hasCell(y, x, "6,1 6,2 6,3 6,4")) return "orange";
	if (frame.phase >= 2 && hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
	if (frame.phase >= 1 && hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
	if (frame.phase >= 3 && hasCell(y, x, "4,5 5,5 6,5 6,6")) return "green";
	return "panel";
}

function piLogoFrame(frameIndex: number, paintBrand: (text: string) => string): string[] {
	const frame = LOGO_FRAMES[frameIndex % LOGO_FRAMES.length]!;
	// Crop the installer's 9-row canvas vertically for a compact header, then
	// tight-crop empty columns so the mark centers cleanly in the logo half
	// (same idea as Claude Code's centered mascot).
	const grid: LogoColor[][] = [];
	for (let y = 1; y <= 7; y++) {
		const row: LogoColor[] = [];
		for (let x = 1; x <= 8; x++) row.push(logoCellColor(frame, y, x));
		grid.push(row);
	}

	let minX = 7;
	let maxX = 0;
	for (const row of grid) {
		row.forEach((cell, x) => {
			if (cell !== "panel") {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
			}
		});
	}
	if (maxX < minX) {
		minX = 0;
		maxX = 7;
	}

	return grid.map((row) => {
		let line = "";
		for (let x = minX; x <= maxX; x++) line += colorCell(row[x]!, paintBrand);
		return line;
	});
}

function borderLine(
	left: string,
	label: string,
	right: string,
	width: number,
	paint: (text: string) => string,
): string {
	if (width <= 1) return "";
	if (width < 8 || label.length === 0) {
		return paint(truncateToWidth(left + "─".repeat(Math.max(0, width - 2)) + right, width, ""));
	}

	const before = "─── ";
	const after = " ─────";
	const fixedWidth = visibleWidth(before) + visibleWidth(label) + visibleWidth(after);
	const fill = Math.max(0, width - 2 - fixedWidth);
	return `${paint(left)}${paint(before)}${label}${paint(after)}${paint("─".repeat(fill))}${paint(right)}`;
}

function boxedLine(content: string, width: number, paint: (text: string) => string): string {
	if (width <= 2) return truncateToWidth(content, width, "");
	return `${paint("│")}${padRight(content, width - 2)}${paint("│")}`;
}

function twoColumn(
	left: string,
	right: string,
	leftWidth: number,
	rightWidth: number,
	paint: (text: string) => string,
): string {
	// Tips sidebar truncates with an ellipsis (Claude Code style); logo half does not.
	return `${padRight(left, leftWidth)} ${paint("│")} ${padRight(right, rightWidth, "…")}`;
}

class PiStartupHeader implements Component {
	private frame = 0;
	private readonly timer: NodeJS.Timeout;
	/** Cached once so logo animation frames don't reshuffle tip commands. */
	private readonly tipCommands: string[];

	// Explicit fields (no TS parameter properties): node's type-stripping
	// runner cannot parse `private readonly x` constructor params, and the
	// pure half of this module is unit-tested via node --test.
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly tui: TUI;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, tui: TUI) {
		this.pi = pi;
		this.ctx = ctx;
		this.tui = tui;
		const pool = collectPiCommandNames(this.pi.getCommands());
		this.tipCommands = pickSlashCommandTips(pool, {
			fixed: ["claude-tui"],
			count: 3,
		});

		this.timer = setInterval(() => {
			if (this.frame < LOGO_FRAMES.length - 1) {
				this.frame++;
				this.tui.requestRender();
			} else {
				clearInterval(this.timer);
			}
		}, LOGO_ANIMATION_INTERVAL_MS);
		this.timer.unref?.();
	}

	render(width: number): string[] {
		const theme = this.ctx.ui.theme;
		const paint = (s: string) => theme.fg("accent", s);
		const muted = (s: string) => theme.fg("muted", s);
		const dim = (s: string) => theme.fg("dim", s);
		const bold = (s: string) => theme.bold(s);

		if (width < 24) return [paint(`Pi v${VERSION}`)];

		const innerWidth = width - 2;
		const { leftWidth, rightWidth, useTips } = headerColumnWidths(innerWidth);
		const model = formatModelLabel(this.ctx.model);
		const effort = readEffortLevel(this.pi) ?? "off";
		const cwd = formatCwd(this.ctx.cwd);

		const leftLines = [
			...piLogoFrame(this.frame, paint).map((line) => center(line, leftWidth)),
			center(bold("Let's build something great"), leftWidth),
			center(muted(`${model} · ${effort} effort`), leftWidth),
			center(dim(cwd), leftWidth),
		];

		// /use-default-tui + 3 random real pi commands (picked once in constructor).
		const tipDivider = paint("─".repeat(Math.max(8, Math.min(rightWidth, 22))));
		const [cmd0 = "", cmd1 = "", cmd2 = "", cmd3 = ""] = this.tipCommands;
		const tipLines = [
			"",
			paint(bold("Getting started")),
			muted("Ask Pi to build it"),
			tipDivider,
			paint(bold("Commands")),
			muted(cmd0),
			muted(cmd1),
			muted(cmd2),
			muted(cmd3),
			"",
		];

		const lines = [borderLine("╭", `${paint("Pi")} v${VERSION}`, "╮", width, paint)];
		for (let i = 0; i < leftLines.length; i++) {
			const content = useTips
				? twoColumn(leftLines[i] ?? "", tipLines[i] ?? "", leftWidth, rightWidth, paint)
				: padRight(leftLines[i] ?? "", leftWidth);
			lines.push(boxedLine(content, width, paint));
		}
		lines.push(borderLine("╰", "", "╯", width, paint));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}


/**
 * Apply the Pi-look startup header (animated logo + "Let's build something
 * great" + model/effort/cwd + tips sidebar). Extracted from the upstream
 * standalone extension for use inside the combined CC-TUI extension.
 */
export function applyPiHeaderLook(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;

	ctx.ui.setTitle("Pi");
	ctx.ui.setHeader((tui) => {
		const header = new PiStartupHeader(pi, ctx, tui);
		activeHeader = header;
		return header;
	});
}

export function disposePiHeaderLook(): void {
	activeHeader?.dispose();
	activeHeader = undefined;
}

let activeHeader: PiStartupHeader | undefined;

// ── Header layout & tips (homed here 2026-10-03 — this module is their only consumer) ──

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
