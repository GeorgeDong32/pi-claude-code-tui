/**
 * CC-style terminal-state rows for assistant messages (spec
 * 2026-10-13-cc-api-error-row): pi renders `stopReason` error / aborted /
 * length as a plain red `Text` at the end of the assistant component
 * (AM:136-154). This module wraps `updateContent` (original first — its
 * leading clear() makes the fallback replay idempotent) and swaps only that
 * trailing node for a CC row:
 *
 *   error   → `  ⎿  API Error: …`  (ccResult error family: 3-row fold,
 *             ctrl+o / click to expand — DEC-A3/A5)
 *   aborted → dim  `  ⎿  Interrupted · What should Pi do instead?` (DEC-A4)
 *   length  → red  `  ⎿  Response was truncated before completion.`
 *
 * Identification is the fail-open oracle (DEC-A2): pi's native branch
 * conditions plus an exact (ANSI-stripped) match of the native trailing
 * text — any drift in pi degrades to the native row, no version gate
 * needed. The `message` object is only ever read.
 */
import { MouseRegion } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { ccResult, createWidthCache, gutterWrapRows, type CCTheme } from "./cc-rows.ts";
import { stripAnsi } from "./claude-tui-editor.ts";
import { PrototypeMethodAdapter, type ThemeFg } from "./pi-proto-adapter.ts";

export type TerminalKind = "error" | "aborted" | "length";

/** pi's native plain text for a terminal row — the identification oracle. */
export function nativeTerminalText(kind: TerminalKind, errorMessage: string | undefined): string {
	if (kind === "length") return "Response was truncated before completion.";
	if (kind === "aborted") {
		return errorMessage && errorMessage !== "Request was aborted" ? errorMessage : "Operation aborted";
	}
	return `Error: ${errorMessage || "Unknown error"}`;
}

/** Strip a leading `Error` / `API Error` prefix (S3: bare forms too). */
const stripErrorPrefix = (s: string): string => s.replace(/^(?:API\s+)?Error(?::\s*|\s*$)/i, "");

/** CC display text (DEC-A3/A4). */
export function ccTerminalText(kind: TerminalKind, errorMessage: string | undefined): string {
	if (kind === "length") return "Response was truncated before completion.";
	if (kind === "aborted") {
		const native = nativeTerminalText("aborted", errorMessage);
		return native === "Operation aborted"
			? "Interrupted · What should Pi do instead?"
			: `Interrupted · ${native}`;
	}
	const body = stripErrorPrefix(errorMessage ?? "");
	return `API Error: ${body || "Unknown error"}`;
}

/** DEC-A2 branch conditions — `hasToolCalls` is read AFTER the original ran. */
export const classifyTerminal = (
	stopReason: unknown,
	hasToolCalls: unknown,
): TerminalKind | null => {
	if (stopReason === "length") return "length";
	if (hasToolCalls === true) return null; // tool rows carry the error
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "error";
	return null;
};

const GUTTER = "  ⎿  ";

/** Pure renderer: error folds via the ccResult family; aborted / length
 * wrap fully under the gutter (no fold, no truncation — S4). */
export function ccTerminalRows(
	theme: CCTheme,
	kind: TerminalKind,
	errorMessage: string | undefined,
	width: number,
	expanded: boolean,
): string[] {
	const text = ccTerminalText(kind, errorMessage);
	if (kind === "error") {
		const comp = ccResult(theme, "api-error", { content: [{ type: "text", text }] }, { expanded }, true);
		return comp.render(width);
	}
	const color = kind === "aborted" ? "dim" : "error";
	return gutterWrapRows([theme.fg(color, text)], width, theme.fg("dim", GUTTER));
}

// ── The patch ────────────────────────────────────────────────────────────

interface AssistantProtoLike {
	contentContainer?: {
		children?: Array<{ text?: unknown } | undefined>;
		removeChild?: (child: unknown) => void;
		addChild?: (child: unknown) => void;
	};
	lastMessage?: { stopReason?: string; errorMessage?: string } | undefined;
	hasToolCalls?: boolean;
	__ccApiErrorExpanded?: boolean;
	__ccApiErrorRowSetExpanded?: boolean;
}

const asHost = (host: unknown): AssistantProtoLike => host as AssistantProtoLike;

/** DEC-A5: instance-level setExpanded so the global ctrl+o walk (duck-typed
 * isExpandable, chatContainer direct children only) reaches the error row.
 * Never overrides a non-ours setExpanded (future native one). */
const ensureInstanceSetExpanded = (host: AssistantProtoLike): void => {
	try {
		const existing = (host as { setExpanded?: unknown }).setExpanded as
			| ((v: boolean) => void)
			| undefined;
		if (typeof existing === "function") return; // ours from a previous rebuild or foreign
		const proto = Object.getPrototypeOf(host) as { setExpanded?: unknown } | null;
		if (proto && typeof proto.setExpanded === "function") return; // native added one
		const fn = (v: boolean): void => {
			try {
				if (host.__ccApiErrorExpanded === v) return;
				host.__ccApiErrorExpanded = v;
				const msg = host.lastMessage;
				if (msg) (host as unknown as { updateContent(m: unknown): void }).updateContent(msg);
			} catch {
				// display state only — never propagate
			}
		};
		fn.__ccApiError = true;
		(host as unknown as { setExpanded?: unknown }).setExpanded = fn;
		host.__ccApiErrorRowSetExpanded = true;
	} catch {
		// never throw inside the patched path
	}
};

const adapter = new PrototypeMethodAdapter({
	proto: AssistantMessageComponent.prototype,
	method: "updateContent",
	marker: "__ccApiErrorRow",
	hostMatches: (host): boolean => {
		const c = asHost(host).contentContainer;
		return (
			c !== undefined
			&& Array.isArray(c.children)
			&& typeof c.removeChild === "function"
			&& typeof c.addChild === "function"
		);
	},
	body: (host, fg, original, args) => {
		// Native first (wrapper semantics): updateContent begins with clear(),
		// so the degrade-path replay is idempotent — no double content (S7).
		original?.apply(host, [...args]);
		const msg = args[0] as { stopReason?: string; errorMessage?: string } | undefined;
		const kind = classifyTerminal(msg?.stopReason, asHost(host).hasToolCalls);
		if (kind === null) return;
		const container = asHost(host).contentContainer!;
		const children = container.children!;
		const last = children[children.length - 1];
		const expected = nativeTerminalText(kind, msg?.errorMessage);
		if (typeof last?.text !== "string") return;
		if (stripAnsi(last.text as string) !== stripAnsi(expected)) return; // pi changed → keep native

		const theme: CCTheme = {
			fg: (c, s) => fg(c, s),
			bold: (s) => fg("bold", s),
		};
		const expanded = asHost(host).__ccApiErrorExpanded === true;
		const cache = createWidthCache();
		const row = {
			invalidate() {
				cache.clear();
			},
			render(width: number): string[] {
				try {
					return cache.serve(width, (w) => ccTerminalRows(theme, kind, msg?.errorMessage, w, expanded));
				} catch {
					return []; // red line 1: render must never throw
				}
			},
		};
		let component: unknown = row;
		if (kind === "error") {
			component = new MouseRegion(row, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				try {
					asHost(host).__ccApiErrorExpanded = !asHost(host).__ccApiErrorExpanded;
					const m = asHost(host).lastMessage;
					if (m) (host as unknown as { updateContent(m: unknown): void }).updateContent(m);
				} catch {
					// click is best-effort
				}
				return { handled: true };
			});
		}
		try {
			container.removeChild!(last);
			container.addChild!(component);
		} catch {
			// failed swap → the native row may be gone; the next updateContent rebuilds
		}
		if (kind === "error") ensureInstanceSetExpanded(asHost(host));
	},
});

/** Apply (first call) or refresh the getter (re-enable / reload). */
export function patchApiErrorRow(getFg: () => ThemeFg | null): void {
	adapter.apply(getFg);
}

/** Withdraw — only while our wrapper is still the installed method. */
export function restoreApiErrorRow(): void {
	adapter.restore();
}
