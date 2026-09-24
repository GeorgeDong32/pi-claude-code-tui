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
	paddingX: number;
	paddingY: number;
	setBgFn(bgFn: ((text: string) => string) | undefined): void;
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
	proto.updateDisplay = function (this: CompactionProto) {
		// Strip the Box chrome: no customMessageBg, no 1x1 padding — the row
		// must sit flush in the transcript like the CC tool rows.
		this.setBgFn(undefined);
		this.paddingX = 0;
		this.paddingY = 0;
		this.clear();
		const fg = (color: string, text: string) => getFg()?.(color, text) ?? text;
		// One quiet grey family for the whole row — the token count must not
		// pop white against the dim compaction line.
		const tokens = this.message.tokensBefore.toLocaleString("en-US");
		const expandHint = keyText("app.tools.expand") || "ctrl+o";
		if (!this.expanded) {
			this.addChild(new Text(
				`${fg("dim", "\u23fa")} ${fg("toolOutput", `Context compacted from ${tokens} tokens`)} ${fg("dim", `(${expandHint} to expand)`)}`,
				0,
				0,
			));
			return;
		}
		this.addChild(new Text(
			`${fg("dim", "\u23fa")} ${fg("toolOutput", `Context compacted ${tokens} tokens`)}`,
			0,
			0,
		));
		for (const line of this.message.summary.split("\n")) {
			this.addChild(new Text(`${fg("dim", "  \u23bf  ")}${fg("toolOutput", line)}`, 0, 0));
		}
	};
}
