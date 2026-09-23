/**
 * CC-compatible statusline (plan SL3): JSON synthesis, badge math, and the
 * one-shot child-process runner.
 *
 * Protocol (verified against ~/.claude/statusline-command.sh's jq fields):
 * the runner feeds a CC-shaped JSON document on stdin and renders the
 * command's stdout lines verbatim (ANSI included). Refreshes are event
 * driven — never per frame — so the render path never spawns.
 */
import { spawn } from "node:child_process";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UsageSnapshot } from "./status-snapshot.ts";

// ---------------------------------------------------------------------------
// JSON synthesis (pure)
// ---------------------------------------------------------------------------

export interface StatuslineModelInfo {
	displayName: string;
	id: string;
	provider?: string;
}

export interface StatuslineExtras {
	cwd?: string;
	effort?: string;
}

/**
 * Build the CC-shaped stdin document. Field names mirror what the reference
 * script actually reads (model.display_name/.id, workspace.current_dir/
 * project_dir, context_window.context_window_size / current_usage.
 * {input,output}_tokens / total_{input,output}_tokens / {used,remaining}_
 * percentage); the `pi` object carries our extensions (cost/effort/provider)
 * which CC scripts ignore via jq's `//` fallbacks.
 */
export function buildStatuslineJson(
	snapshot: UsageSnapshot,
	model: StatuslineModelInfo,
	contextWindow: number,
	extras: StatuslineExtras = {},
): string {
	const cwd = extras.cwd ?? process.cwd();
	const usedPct = contextWindow > 0 ? Math.min(100, Math.round((snapshot.used / contextWindow) * 100)) : 0;
	return JSON.stringify({
		model: {
			display_name: model.displayName,
			id: model.id,
		},
		workspace: {
			current_dir: cwd,
			project_dir: cwd,
		},
		context_window: {
			context_window_size: contextWindow,
			current_usage: {
				input_tokens: snapshot.lastInput,
				output_tokens: snapshot.lastOutput,
			},
			total_input_tokens: snapshot.totalInput,
			total_output_tokens: snapshot.totalOutput,
			used_percentage: usedPct,
			remaining_percentage: 100 - usedPct,
		},
		pi: {
			cost_usd: snapshot.cost,
			effort: extras.effort ?? "",
			provider: model.provider ?? "",
		},
	});
}

// ---------------------------------------------------------------------------
// Badge math (pure) — plan D4
// ---------------------------------------------------------------------------

/**
 * Right-align `badge` on `line` (the first statusline line). Returns null
 * when the two cannot fit with a ≥2-column gap — the script's output is
 * never truncated or rewrapped to make room. Both sides may carry ANSI
 * escapes and double-width glyphs; widths are visual.
 */
export function appendBadge(line: string, badge: string, width: number): string | null {
	if (!badge || width <= 0) return null;
	const lineW = visibleWidth(line);
	const badgeW = visibleWidth(badge);
	if (lineW + 2 + badgeW > width) return null;
	const pad = " ".repeat(width - lineW - badgeW);
	return `${line}${pad}${badge}`;
}

// ---------------------------------------------------------------------------
// Footer composition (pure) — plan SL4/D2
// ---------------------------------------------------------------------------

export interface FooterComposeInput {
	/** Statusline feature enabled (script/error rows participate at all). */
	statuslineOn: boolean;
	/** D4: right-align the effort chip on the first script line. */
	badgeOn: boolean;
	/** Runner output (or its persistent-error line). */
	lines: string[];
	/** Chip text before painting; "" disables the chip for this frame. */
	badgeText: string;
	/** Applies the muted paint to the badge text. */
	badgePaint: (s: string) => string;
	/** Pre-painted mode/hints line; "" when the slot already carries it (native-off). */
	hints: string;
	width: number;
}

/**
 * Compose the belowEditor cc-footer widget's rows (plan D2): user statusline
 * lines first, then the mode/hints line — the widget always yields at least
 * one row so the dock never collapses it to zero height.
 */
export function composeFooterLines(input: FooterComposeInput): string[] {
	const out: string[] = [];
	if (input.statuslineOn && input.lines.length > 0) {
		const first = input.lines[0]!;
		let line0 = first;
		if (input.badgeOn && input.badgeText) {
			line0 = appendBadge(first, input.badgePaint(input.badgeText), input.width) ?? first;
		}
		out.push(line0, ...input.lines.slice(1));
	}
	if (input.hints !== "") out.push(input.hints);
	return out.length > 0 ? out : [""];
}

// ---------------------------------------------------------------------------
// Runner — debounced one-shot spawn, off the render path
// ---------------------------------------------------------------------------

/** Minimal child-process surface the runner touches (injectable for tests). */
export interface ChildLike {
	stdout: { on(event: "data", listener: (chunk: string | Buffer) => void): void } | null;
	stdin: { write(data: string): void; end(data?: string): void } | null;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
	on(event: "error", listener: (err: Error) => void): void;
	kill(signal?: string): void;
}

export type SpawnFn = (
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildLike;

const realSpawn: SpawnFn = (command, args, options) =>
	spawn(command, args, { ...options, stdio: ["pipe", "pipe", "ignore"] }) as unknown as ChildLike;

export interface StatuslineRunnerOptions {
	/** Shell command; run via `bash -c`, JSON on stdin. */
	command: string;
	/** Coalesce window for request() bursts (default 250ms). */
	debounceMs?: number;
	/** Kill the child after this long (default 2000ms). */
	timeoutMs?: number;
	/** Cap rendered lines (default 4). */
	maxLines?: number;
	/** Stop collecting stdout past this (default 64KB) so a runaway script cannot balloon memory. */
	maxOutputBytes?: number;
	spawnFn?: SpawnFn;
}

const DEFAULTS = { debounceMs: 250, timeoutMs: 2000, maxLines: 4, maxOutputBytes: 64 * 1024 };

/** Split raw stdout into rendered lines: CRLF-safe, trailing blanks dropped, capped. */
export function splitStatuslineOutput(out: string, maxLines: number): string[] {
	const lines = out.replace(/\r\n/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines.slice(0, maxLines);
}

export class StatuslineRunner {
	private readonly command: string;
	private readonly debounceMs: number;
	private readonly timeoutMs: number;
	private readonly maxLines: number;
	private readonly maxOutputBytes: number;
	private readonly spawnFn: SpawnFn;

	private onUpdate: (() => void) | null = null;
	private lines: string[] = [];
	private errorLine: string | null = null;
	private consecutiveFailures = 0;
	private timer: NodeJS.Timeout | null = null;
	private child: ChildLike | null = null;
	private killTimer: NodeJS.Timeout | null = null;
	private pendingAfterInFlight = false;
	private lastInput = "";
	private lastWidth = 0;
	/** Input/width the in-flight child actually received (set at launch). */
	private activeInput = "";
	private activeWidth = 0;
	/** Input/width of the last completed run — identical requests are no-ops. */
	private servedInput = "";
	private servedWidth = 0;
	private disposed = false;

	constructor(options: StatuslineRunnerOptions) {
		this.command = options.command;
		this.debounceMs = options.debounceMs ?? DEFAULTS.debounceMs;
		this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
		this.maxLines = options.maxLines ?? DEFAULTS.maxLines;
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
		this.spawnFn = options.spawnFn ?? realSpawn;
	}

	/** Called after each completed run so the host can requestRender(). */
	setOnUpdate(callback: (() => void) | null): void {
		this.onUpdate = callback;
	}

	/**
	 * Ask for a refresh. Bursts coalesce into one spawn (latest input wins);
	 * a request arriving mid-flight marks a single follow-up run; a request
	 * identical to the last served state is a no-op.
	 */
	request(input: string, width: number): void {
		if (this.disposed) return;
		this.lastInput = input;
		this.lastWidth = width;
		if (this.child) {
			this.pendingAfterInFlight = true;
			return;
		}
		if (input === this.servedInput && width === this.servedWidth && this.timer === null) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.launch();
		}, this.debounceMs);
	}

	/** Lines to render: the dim error note once failures persist, else output. */
	getRenderLines(): string[] {
		return this.errorLine ? [this.errorLine] : this.lines;
	}

	/** True once the command has failed `consecutiveFailures >= 3` times. */
	hasPersistentError(): boolean {
		return this.errorLine !== null;
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.killTimer) {
			clearTimeout(this.killTimer);
			this.killTimer = null;
		}
		if (this.child) {
			const child = this.child;
			this.child = null;
			child.kill();
		}
	}

	private launch(): void {
		if (this.disposed) return;
		this.activeInput = this.lastInput;
		this.activeWidth = this.lastWidth;
		let child: ChildLike;
		try {
			child = this.spawnFn("bash", ["-c", this.command], {
				cwd: process.cwd(),
				env: { ...process.env, OVERRIDE_TERM_WIDTH: String(this.lastWidth) },
			});
		} catch (err) {
			this.settle(`spawn: ${(err as Error).message}`);
			return;
		}
		this.child = child;

		// Collect raw buffers and decode once at settle: streaming chunks can
		// split a UTF-8 sequence mid-way (mojibake), a single concat cannot.
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		let timedOut = false;
		const finish = (reason: string) => {
			if (settled) return;
			settled = true;
			this.settle(reason, Buffer.concat(chunks).toString("utf8"));
		};

		this.killTimer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill(); // SIGTERM first
			} catch {
				// already gone — exit/error event settles the run
			}
			// Escalate: a script that traps SIGTERM must not hang the slot.
			this.killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
			}, 750);
		}, this.timeoutMs);

		child.stdout?.on("data", (chunk) => {
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			bytes += buf.length;
			if (bytes > this.maxOutputBytes) return; // stop collecting, keep what we have
			chunks.push(buf);
		});
		child.on("exit", (code) => {
			if (this.killTimer) {
				clearTimeout(this.killTimer);
				this.killTimer = null;
			}
			finish(timedOut ? "timeout" : code === 0 ? "ok" : `exit ${code ?? "?"}`);
		});
		child.on("error", (err) => {
			if (this.killTimer) {
				clearTimeout(this.killTimer);
				this.killTimer = null;
			}
			finish(`error: ${err.message}`);
		});

		try {
			child.stdin?.write(this.lastInput);
			child.stdin?.end();
		} catch {
			// EPIPE racing a fast-exiting script — the exit event still settles
		}
	}

	private settle(reason: string, out = ""): void {
		this.child = null;
		if (this.disposed) return;
		// What completed is what the child was fed at launch — NOT lastInput,
		// which may have moved on while the child was in flight.
		this.servedInput = this.activeInput;
		this.servedWidth = this.activeWidth;

		if (reason === "ok") {
			this.consecutiveFailures = 0;
			this.errorLine = null;
			this.lines = splitStatuslineOutput(out, this.maxLines);
		} else {
			this.consecutiveFailures++;
			if (this.consecutiveFailures >= 3) {
				this.errorLine = `<statusline> cmd failed (${reason}) — /claude-statusline off`;
			}
		}
		this.onUpdate?.();

		if (this.pendingAfterInFlight) {
			this.pendingAfterInFlight = false;
			// The mid-flight request differs from what just ran, so request()'s
			// dedup lets it through and schedules the follow-up.
			this.request(this.lastInput, this.lastWidth);
		}
	}
}
