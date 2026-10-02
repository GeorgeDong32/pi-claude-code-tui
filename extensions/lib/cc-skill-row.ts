/**
 * CC-style skill invocation row (2026-09-26).
 *
 * pi's native SkillInvocationMessageComponent renders a [skill] box on
 * customMessageBg — "[skill] name (ctrl+o to expand)" collapsed, the whole
 * SKILL.md body as Markdown expanded. CC renders a skill use as a plain
 * tool row: renderToolUseMessage returns just the skill name, so the row
 * reads "⏺ Skill(improve-codebase-architecture)" (src/tools/SkillTool/UI.tsx).
 * Prototype-patch the component into that family:
 *
 *   collapsed:  ⏺ Skill(improve-codebase-architecture) (ctrl+o to expand)
 *   expanded:   ⏺ Skill(improve-codebase-architecture)
 *                 ⎿  <skill body, wrapped under the gutter>
 *
 * Same recipe as cc-compaction-row.ts: idempotent prototype patch, Box
 * chrome stripped (no customMessageBg, no 1x1 padding), theme read lazily
 * per render via getFg (ctx may go stale after session replace). Expansion
 * state stays native — the global ctrl+o walk calls setExpanded(bool) and
 * keeps working untouched. Unlike the compaction patch this one re-arms the
 * MouseRegion so the native click-to-expand keeps working.
 */
import { keyText, SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type ThemeFg = (color: string, text: string) => string;

// Byte-compatible with cc-rows ccCall's name segment: white + bold.
const WHITE = "\x1b[38;2;255;255;255m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const RESET = "\x1b[39m";
// Same gutter as the compaction summary / CC result rows (visible width 5).
const GUTTER = "  ⎿  ";

interface SkillInvocationProto {
	skillBlock: { name: string; location: string; content: string; userMessage?: string };
	expanded: boolean;
	paddingX: number;
	paddingY: number;
	setBgFn(bgFn: ((text: string) => string) | undefined): void;
	clear(): void;
	addChild(component: unknown): void;
	updateDisplay(): void;
	setExpanded(expanded: boolean): void;
	__ccSkillRowPatched?: boolean;
}

/** Idempotent prototype patch. `getFg` is read lazily per render so a
 * re-cached theme (session replace) is always current. */
export function patchSkillRow(getFg: () => ThemeFg | null): void {
	const proto = SkillInvocationMessageComponent.prototype as unknown as SkillInvocationProto;
	if (proto.__ccSkillRowPatched) return;
	proto.__ccSkillRowPatched = true;
	proto.updateDisplay = function (this: SkillInvocationProto) {
		// Strip the Box chrome: no customMessageBg, no 1x1 padding — the row
		// must sit flush in the transcript like the CC tool rows.
		this.setBgFn(undefined);
		this.paddingX = 0;
		this.paddingY = 0;
		this.clear();
		const fg = (color: string, text: string) => getFg()?.(color, text) ?? text;
		const name = this.skillBlock?.name ?? "";
		const expanded = !!this.expanded;
		// Call-row head, same shape as cc-rows ccCall's resolved state:
		// success dot + white bold "Skill(" — a resolved tool use in the
		// CC family (SkillTool/UI.tsx shows the name, nothing else).
		const head = `${fg("success", "⏺")} ${WHITE}${BOLD}Skill${BOLD_OFF}(`;
		const expandHint = keyText("app.tools.expand") || "ctrl+o";
		const row = {
			invalidate() {},
			render(width: number): string[] {
				if (!expanded) {
					const hint = ` ${fg("dim", `(${expandHint} to expand)`)}`;
					const avail = Math.max(1, width - visibleWidth(head) - 1 - visibleWidth(hint));
					return [`${head}${truncateToWidth(name, avail, "…")})${hint}`];
				}
				return [`${head}${name})${RESET}`];
			},
		};
		const content = new Container();
		content.addChild(row);
		if (expanded) {
			// Skill body as ONE guttered block, byte-consistent with the
		// ccResult family: only the first physical row carries the ⎿, every
		// other row (wrapped continuations, blank lines) aligns under it
		// with a 5-space indent. Wrap-once cache per width, same as ccResult.
			const lines = (this.skillBlock?.content ?? "").replace(/\n+$/, "").split("\n");
			let cache: { width: number; rows: string[] } | null = null;
			content.addChild({
				invalidate() {
					cache = null;
				},
				render(width: number): string[] {
					if (cache && cache.width === width) return cache.rows;
					const cont = "     ";
				const wrapW = Math.max(10, width - cont.length);
					const physical: string[] = [];
					for (const line of lines) physical.push(...wrapTextWithAnsi(line, wrapW));
					const rows = physical.map((l, i) => `${i === 0 ? fg("dim", GUTTER) : cont}${fg("toolOutput", l)}`);
					cache = { width, rows };
					return rows;
				},
			});
		}
		// Re-arm the native click-to-expand (the compaction patch drops its
		// MouseRegion; the skill row always had one, keep the behavior).
		// Native structure: the content is added ONCE, wrapped in the region.
		this.addChild(new MouseRegion(content, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		}));
	};
}
