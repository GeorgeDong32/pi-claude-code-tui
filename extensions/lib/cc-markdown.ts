/**
 * CC-style markdown transformers (extracted 2026-10-03 from the entry
 * factory — pure string→string logic, byte-identical, now table-tested).
 *
 * Assistant messages: plain prose lines are painted CC white (rgb 255,255,255)
 * so the body reads like Claude Code's; markdown-styled lines (headings,
 * quotes, lists, code fences, tables) keep their own theme colors.
 *
 * User messages: a full-row grey bar (CC userMessageBackground rgb(55,55,55))
 * with a ❯ prompt on the first row.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

const WHITE = "\x1b[38;2;255;255;255m";
const RESET = "\x1b[39m";
const BG = "\x1b[48;2;55;55;55m"; // CC userMessageBackground rgb(55,55,55)
const BG_OFF = "\x1b[49m";

/** A line with no markdown structure — eligible for the white paint. */
const plainLine = (l: string): boolean => !/^(\s*[#>*`\-|]|\s*\d+\.)/.test(l) && l.trim() !== "";

/**
 * Paint plain prose white, fence-aware: inside a ``` fence every line keeps
 * its syntax highlighting; list items wrap only the text after the marker so
 * the markdown list structure survives.
 */
export const assistantWhiteText = (markdown: string): string => {
	let inFence = false;
	return markdown
		.split("\n")
		.map((l) => {
			if (/^\s*```/.test(l)) {
				inFence = !inFence;
				return l;
			}
			if (inFence) return l; // keep syntax highlighting
			// list items: wrap only the text after the marker so the
			// markdown list structure survives
			const m = l.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/);
			if (m && m[2]!.trim() !== "") return `${m[1]}${WHITE}${m[2]}${RESET}`;
			return plainLine(l) ? `${WHITE}${l}${RESET}` : l;
		})
		.join("\n");
};

/**
 * Full-row grey bar for user messages. `gray` paints the ❯ prompt (theme
 * dim in production). Pads with NBSPs: plain trailing spaces get trimmed by
 * the markdown renderer, NBSPs survive, so the bar spans the full row.
 */
export const userMessageBar = (markdown: string, width: number, gray: (s: string) => string): string => {
	return markdown
		.split("\n")
		.map((line, i) => {
			const text = `${WHITE}${line}${RESET}`;
			const content = i === 0 ? `${gray("❯")} ${text}` : `  ${text}`;
			const pad = "\u00A0".repeat(Math.max(0, width - visibleWidth(content) - 1));
			return `${BG}${content}${pad}${BG_OFF}`;
		})
		.join("\n");
};
