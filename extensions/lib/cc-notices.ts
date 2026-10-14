/**
 * cc-notices (spec 2026-10-13-cc-notices): compact pi's native
 * showError/showWarning notice blocks into one-liners and keep the full
 * text retrievable via the /notice CustomEntry snapshot.
 *
 * Deep module: the tap side only depends on `intercept` — everything else
 * (budget math, merging, modes, snapshot shaping) lives behind it. All
 * exported functions are pure/injected and never throw (AGENTS trap 1).
 *
 * DEC map — N2 modes (compact default), N3 budget/compaction, N5
 * process-wide singleton on globalThis, N6 snapshot shape (16k truncation,
 * no altered/viewed persisted), N7 chip text, N9 fatal-exit stderr dump,
 * N11 fail-open taps (install only when both host methods exist), N12 the
 * coverage boundary (direct chatContainer writers stay native).
 */
import { writeSync } from "node:fs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { gutterWrapRows, type CCTheme } from "./cc-rows.ts";
import { PrototypeMethodAdapter } from "./pi-proto-adapter.ts";

export type NoticeLevel = "error" | "warning";
export type NoticeMode = "compact" | "quiet" | "off";

export interface NoticeRecord {
	readonly level: NoticeLevel;
	readonly message: string;
	readonly at: number;
	readonly count: number;
	readonly altered: boolean;
	readonly viewed: boolean;
}

export interface NoticeUnread {
	errors: number;
	warnings: number;
}

export interface NoticeCenter {
	/** Record + decide the native display: same string (passthrough), a
	 * compact one-liner, or null (quiet — the caller must not invoke the
	 * original). `padX` is the host Text's horizontal padding (DEC-N3
	 * budget). Never throws; internal failure fails open to passthrough. */
	intercept(level: NoticeLevel, message: string, padX?: number): string | null;
	unread(): NoticeUnread;
	snapshot(): readonly NoticeRecord[];
	markRead(): void;
	clear(): void;
	mode(): NoticeMode;
	setMode(mode: NoticeMode): void;
}

export interface NoticeCenterDeps {
	now(): number;
	columns(): number;
	capacity?: number;
}

// ── DEC-N3: compaction ───────────────────────────────────────────────────

/** Routed pointer: when the raw message carries its own actionable command
 * (pi's MCP warning ends with `Run /mcp to fix.`), route the tail pointer
 * there instead of the generic /notice — CC embeds such pointers in the
 * message text (`Use /mcp to authenticate.`, MCPReconnect.tsx) so the
 * suggested next step is the fixer, not the log. Last match wins; /notice
 * itself is never a routing target. */
export function extractActionPointer(message: string): string | null {
	let found: string | null = null;
	for (const m of message.matchAll(/\b(?:run|use)\s+(\/[a-zA-Z][\w:-]*)/gi)) {
		if (m[1]!.toLowerCase() !== "/notice") found = m[1]!;
	}
	return found;
}

const BUDGET_FLOOR = 40;
/** DEC-N6: cap a snapshot message so session files cannot grow unbounded. */
export const SNAPSHOT_MESSAGE_LIMIT = 16_000;

const levelPrefix = (level: NoticeLevel): string => (level === "error" ? "Error: " : "Warning: ");

/** Pure compaction (DEC-N3). `null` = passthrough: single physical line
 * that fits the budget (empty/whitespace included). Otherwise the first
 * non-empty line, whitespace-collapsed, truncated with an ellipsis and a
 * tail pointer appended — the message's own action command when it has
 * one (`extractActionPointer`), else the generic /notice. Widths via
 * pi-tui (CJK + ANSI safe). */
export function compactNotice(message: string, budget: number, pointer: string = "/notice"): string | null {
	const b = Math.max(BUDGET_FLOOR, budget);
	const ptr = ` · ${pointer}`;
	if (!message.includes("\n") && visibleWidth(message) <= b) return null;
	const firstLine =
		message
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? "";
	if (firstLine === "") return null;
	const collapsed = firstLine.replace(/\s+/g, " ");
	return `${truncateToWidth(collapsed, Math.max(1, b - visibleWidth(ptr)), "…")}${ptr}`;
}

// ── DEC-N5: center + process-wide singleton ──────────────────────────────

const DEFAULT_CAPACITY = 50;

interface MutableNoticeRecord {
	level: NoticeLevel;
	message: string;
	at: number;
	count: number;
	altered: boolean;
	viewed: boolean;
}

export function createNoticeCenter(deps: NoticeCenterDeps): NoticeCenter {
	const capacity = Math.max(1, deps.capacity ?? DEFAULT_CAPACITY);
	const records: MutableNoticeRecord[] = [];
	let currentMode: NoticeMode = "compact";

	const budgetFor = (level: NoticeLevel, padX: number, pointer: string): number =>
		Math.max(
			BUDGET_FLOOR,
			deps.columns() - 2 * padX - visibleWidth(levelPrefix(level)) - visibleWidth(` · ${pointer}`),
		);

	const toRecord = (r: MutableNoticeRecord): NoticeRecord => ({ ...r });

	return {
		intercept(level, message, padX = 1) {
			try {
				const now = deps.now();
				const last = records.length > 0 ? records[records.length - 1] : undefined;
				const merged = last !== undefined && last.level === level && last.message === message;
				if (!merged) {
					records.push({ level, message, at: now, count: 0, altered: false, viewed: true });
					if (records.length > capacity) records.shift();
				}
				const rec = records[records.length - 1]!;
				rec.count += 1;
				rec.at = now;

				let occurrenceAltered = false;
				let display: string | null = message;
				if (currentMode === "quiet") {
					occurrenceAltered = true;
					display = null;
				} else if (currentMode === "compact") {
					const ptr = extractActionPointer(message) ?? "/notice";
					const one = compactNotice(message, budgetFor(level, padX, ptr), ptr);
					if (one !== null) {
						occurrenceAltered = true;
						display = one;
					}
				}
				if (occurrenceAltered) {
					// S7: a fresh occurrence has not been seen yet — reset on
					// merge too, or repeat notices never count as unread.
					rec.altered = true;
					rec.viewed = false;
				}
				return display;
			} catch {
				return message; // fail-open: native full text
			}
		},
		unread() {
			const out: NoticeUnread = { errors: 0, warnings: 0 };
			for (const r of records) {
				if (!r.altered || r.viewed) continue;
				if (r.level === "error") out.errors += 1;
				else out.warnings += 1;
			}
			return out;
		},
		snapshot() {
			return records.map(toRecord);
		},
		markRead() {
			for (const r of records) r.viewed = true;
		},
		clear() {
			records.length = 0;
		},
		mode() {
			return currentMode;
		},
		setMode(mode: NoticeMode) {
			currentMode = mode;
		},
	};
}

const NOTICE_SLOT = Symbol.for("pi-claude-code-tui/notices");
const EXIT_DUMP_SLOT = Symbol.for("pi-claude-code-tui/notices-exit-dump");

type NoticeSlot = { v: 1; center: NoticeCenter };

/** Process-wide singleton (DEC-N5): jiti `moduleCache: false` gives /reload
 * a second module instance, but the adapter marker hand-off only refreshes
 * the theme getter — body closures keep reading this shared object, so old
 * and new instances share one buffer. */
export function sharedNoticeCenter(): NoticeCenter {
	const g = globalThis as Record<symbol, unknown>;
	const slot = g[NOTICE_SLOT] as NoticeSlot | undefined;
	if (slot && typeof slot === "object" && slot.v === 1 && typeof slot.center?.intercept === "function") {
		return slot.center;
	}
	const center = createNoticeCenter({
		now: () => Date.now(),
		columns: () => process.stdout.columns ?? 100,
	});
	g[NOTICE_SLOT] = { v: 1, center };
	return center;
}

// ── DEC-N6: entry snapshot + rows ────────────────────────────────────────

export interface NoticeSnapshotItem {
	level: NoticeLevel;
	message: string;
	at: number;
	count: number;
}
export interface NoticeSnapshot {
	v: 1;
	takenAt: number;
	notices: NoticeSnapshotItem[];
}

/** Shape the entry payload (DEC-N6): only the fields the renderer needs —
 * `altered`/`viewed` are view state and are not persisted. Messages longer
 * than 16k chars are truncated and marked. */
export function buildNoticeSnapshot(center: NoticeCenter, takenAt: number): NoticeSnapshot {
	const notices: NoticeSnapshotItem[] = center.snapshot().map((r) => ({
		level: r.level,
		message:
			r.message.length > SNAPSHOT_MESSAGE_LIMIT
				? `${r.message.slice(0, SNAPSHOT_MESSAGE_LIMIT)}…(truncated)`
				: r.message,
		at: r.at,
		count: r.count,
	}));
	return { v: 1, takenAt, notices };
}

// Byte-compatible with the cc-rows family heads (white + bold name).
const WHITE = "\x1b[38;2;255;255;255m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const RESET = "\x1b[39m";
const GUTTER = "  ⎿  ";

const defaultFmtTime = (at: number): string =>
	new Date(at).toLocaleTimeString("en-GB", { hour12: false });

const firstNonEmptyLine = (message: string): string => {
	for (const line of message.split("\n")) {
		const t = line.trim();
		if (t.length > 0) return t.replace(/\s+/g, " ");
	}
	return "";
};

const isSnapshotItem = (v: unknown): v is NoticeSnapshotItem =>
	typeof v === "object" && v !== null
	&& ((v as NoticeSnapshotItem).level === "error" || (v as NoticeSnapshotItem).level === "warning")
	&& typeof (v as NoticeSnapshotItem).message === "string"
	&& typeof (v as NoticeSnapshotItem).at === "number"
	&& typeof (v as NoticeSnapshotItem).count === "number";

/** Rows for the `cc-tui/notices` CustomEntry. Collapsed = ONE row (head +
 * latest summary + expand hint); expanded = head + one guttered block per
 * notice (dim HH:MM:SS, level color, `×N` when count > 1). Malformed data
 * → `[]`; never throws (AGENTS trap 1). */
export function noticeEntryRows(
	theme: CCTheme,
	data: unknown,
	width: number,
	expanded: boolean,
	fmtTime: (at: number) => string = defaultFmtTime,
): string[] {
	try {
		if (typeof data !== "object" || data === null) return [];
		const snap = data as NoticeSnapshot;
		if (snap.v !== 1 || !Array.isArray(snap.notices) || snap.notices.length === 0) return [];
		if (!snap.notices.every(isSnapshotItem)) return [];
		const notices = snap.notices;
		const errors = notices.filter((n) => n.level === "error").length;
		const warnings = notices.length - errors;
		const dot = theme.fg(errors > 0 ? "error" : "warning", "⏺");
		const head = `${dot} ${WHITE}${BOLD}Notices${BOLD_OFF}(${notices.length} · ${errors} error${errors === 1 ? "" : "s"} · ${warnings} warning${warnings === 1 ? "" : "s"})${RESET}`;

		if (!expanded) {
			const latest = firstNonEmptyLine(notices[notices.length - 1]!.message);
			const hint = ` ${theme.fg("dim", "(ctrl+o to expand)")}`;
			const fixed = visibleWidth(head) + visibleWidth(hint) + 3; // head + " · " + hint
			const budget = Math.max(1, width - fixed);
			const summary = theme.fg("dim", truncateToWidth(latest, budget, "…"));
			return [truncateToWidth(`${head} · ${summary}${hint}`, width, "")];
		}

		const rows = [head];
		for (const n of notices) {
			const color = n.level === "error" ? "error" : "warning";
			const lead = `${theme.fg("dim", `[${fmtTime(n.at)}]`)} ${theme.fg(color, n.level)}${n.count > 1 ? ` ${theme.fg("dim", `×${n.count}`)}` : ""}`;
			const logical = [lead, ...n.message.split("\n").map((l) => theme.fg(color, l))];
			rows.push(...gutterWrapRows(logical, width, theme.fg("dim", GUTTER)));
		}
		return rows;
	} catch {
		return [];
	}
}

// ── DEC-N7: quiet chip ───────────────────────────────────────────────────

/** `""` when nothing is unread; error color beats warning color. */
export function noticeChip(theme: CCTheme, unread: NoticeUnread): string {
	const total = unread.errors + unread.warnings;
	if (total <= 0) return "";
	return theme.fg(
		unread.errors > 0 ? "error" : "warning",
		`⚠ ${total} notice${total === 1 ? "" : "s"} · /notice`,
	);
}

// ── DEC-N6/S6: local click-to-expand override tracker ──────────────────

/** The global ctrl+o is the primary expansion channel; clicking (fullscreen
 * only) flips a LOCAL override keyed by the stable entry object. When the
 * global state later diverges from the state the override was recorded at,
 * the override voids (S6 — never fight the global toggle). */
export interface NoticeExpansionTracker {
	/** Current effective expansion for an entry at the given global state. */
	effective(entry: object, atGlobal: boolean): boolean;
	/** Flip the local override; returns the new effective value. */
	toggle(entry: object, atGlobal: boolean): boolean;
}

export function createNoticeExpansionTracker(): NoticeExpansionTracker {
	const overrides = new WeakMap<object, { value: boolean; atGlobal: boolean }>();
	const effective = (entry: object, atGlobal: boolean): boolean => {
		const local = overrides.get(entry);
		return local !== undefined && local.atGlobal === atGlobal ? local.value : atGlobal;
	};
	return {
		effective,
		toggle(entry, atGlobal) {
			const next = !effective(entry, atGlobal);
			overrides.set(entry, { value: next, atGlobal });
			return next;
		},
	};
}

// ── Taps (DEC-N10/N11 wiring lives in the entry) ─────────────────────────

export interface NoticeTapDeps {
	center: () => NoticeCenter;
	repaint: () => void;
}

/** The host's own repaint (S1): the suppressed original no longer calls
 * requestRender, so the chip needs one. `host.ui.requestRender()` — the
 * same call the native method tail makes (:3791) — before any fallback. */
const requestHostRender = (host: Record<string, unknown>): boolean => {
	try {
		const ui = host.ui as { requestRender?: unknown } | undefined;
		if (ui && typeof ui.requestRender === "function") {
			ui.requestRender();
			return true;
		}
	} catch {
		// fall through to the injected repaint
	}
	return false;
};

/** Two PrototypeMethodAdapters over showError/showWarning. Install only
 * when both methods exist on the proto (DEC-N11 — the entry checks); the
 * body reads host state, never writes it, and calls the original LAST
 * (DEC-N4: the degrade path replays it). */
export function createNoticeTaps(
	proto: object,
	deps: NoticeTapDeps,
): { apply(): void; restore(): void } {
	const mk = (level: NoticeLevel, method: string, marker: string) =>
		new PrototypeMethodAdapter({
			proto,
			method,
			marker,
			hostMatches: (host) => host !== null && typeof host === "object",
			body: (host, _fg, original, args) => {
				const raw = args[0];
				if (typeof raw !== "string") {
					original?.apply(host, [...args]); // defensive passthrough (S9)
					return;
				}
				const padX =
					level === "error" && typeof (host as { outputPad?: unknown }).outputPad === "number"
						? (host as { outputPad: number }).outputPad
						: 1;
				const display = deps.center().intercept(level, raw, padX);
				if (display === null) {
					// quiet: the original never runs; repaint for the chip.
					if (!requestHostRender(host)) {
						try {
							deps.repaint();
						} catch {
							// a missed repaint only delays the chip
						}
					}
					return;
				}
				original?.apply(host, display === raw ? [...args] : [display, ...args.slice(1)]); // LAST step (DEC-N4)
			},
		});
	const errorTap = mk("error", "showError", "__ccNoticesError");
	const warningTap = mk("warning", "showWarning", "__ccNoticesWarning");
	const noFg = () => null;
	return {
		apply() {
			errorTap.apply(noFg);
			warningTap.apply(noFg);
		},
		restore() {
			errorTap.restore();
			warningTap.restore();
		},
	};
}

// ── DEC-N9: fatal-exit stderr dump ───────────────────────────────────────

/** Strip SGR + APC sequences so the dump is plain text on any pipe. */
const stripForDump = (s: string): string =>
	s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");

/**
 * Dump unread full texts to stderr when the process exits non-zero: after
 * `handleFatalRuntimeError` the transcript is gone, so compact/quiet would
 * otherwise swallow the text entirely. Registered once per process; the
 * write is synchronous (`exit` callbacks cannot rely on async pipe I/O),
 * failures swallowed. `code === 0` stays silent.
 */
export function installFatalExitDump(
	center: () => NoticeCenter,
	write: (s: string) => void = (s) => {
		try {
			writeSync(2, s);
		} catch {
			// never throw out of an exit callback
		}
	},
	on: (fn: (code: number) => void) => void = (fn) => process.once("exit", fn),
): void {
	const g = globalThis as Record<symbol, unknown>;
	if (g[EXIT_DUMP_SLOT] === true) return; // once per process (reload-safe)
	g[EXIT_DUMP_SLOT] = true;
	on((code) => {
		try {
			if (code === 0) return;
			const un = center().unread();
			const total = un.errors + un.warnings;
			if (total === 0) return;
			const lines: string[] = [`[claude-tui] ${total} notice(s) not shown in full:`];
			for (const rec of center().snapshot()) {
				if (!rec.altered || rec.viewed) continue;
				lines.push(
					`- ${new Date(rec.at).toISOString()} [${rec.level}]${rec.count > 1 ? ` ×${rec.count}` : ""} ${stripForDump(rec.message)}`,
				);
			}
			write(`${lines.join("\n")}\n`);
		} catch {
			// best-effort only
		}
	});
}
