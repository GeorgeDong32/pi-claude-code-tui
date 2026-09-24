/**
 * CC-style compaction row (2026-09-24).
 *
 * pi's native CompactionSummaryMessageComponent renders a [compaction] box
 * on customMessageBg with "Compacted from N tokens". Prototype-patch it
 * into the same visual family as the CC tool rows: one
 * "⏺ Context compacted from N tokens" line, with the summary expanding
 * under the standard ⎿ gutter via ctrl+o.
 */
import { CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export type ThemeFg = (color: string, text: string) => string;

interface CompactionProto {
	message: { summary: string; tokensBefore: number };
	expanded: boolean;
	clear(): void;
	addChild(component: unknown): void;
	updateDisplay(): void;
	__ccRowsPatched?: boolean;
}

/** Idempotent prototype patch. `getFg` is read lazily per render so a
 * re-cached theme (session replace) is always current. */
export function patchCompactionRow(getFg: () => ThemeFg | null): void {
	const proto = CompactionSummaryMessageComponent.prototype as unknown as CompactionProto;
	if (proto.__ccRowsPatched) return;
	proto.__ccRowsPatched = true;
	const WHITE = "\x1b[38;2;255;255;255m";
	const BOLD = "\x1b[1m";
	const RESET = "\x1b[22m\x1b[39m";
	proto.updateDisplay = function (this: CompactionProto) {
		this.clear();
		const fg = (color: string, text: string) => getFg()?.(color, text) ?? text;
		const tokens = this.message.tokensBefore.toLocaleString("en-US");
		const expandHint = keyText("app.tools.expand") || "ctrl+o";
		if (!this.expanded) {
			this.addChild(new Text(
				`${fg("dim", "\u23fa")} ${fg("toolOutput", "Context compacted from")} ${WHITE}${BOLD}${tokens} tokens${RESET} ${fg("dim", `(${expandHint} to expand)`)}`,
				0,
				0,
			));
			return;
		}
		this.addChild(new Text(
			`${fg("dim", "\u23fa")} ${fg("toolOutput", "Context compacted")} ${WHITE}${BOLD}${tokens} tokens${RESET}`,
			0,
			0,
		));
		for (const line of this.message.summary.split("\n")) {
			this.addChild(new Text(`${fg("dim", "  \u23bf  ")}${fg("toolOutput", line)}`, 0, 0));
		}
	};
}
