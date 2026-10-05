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
import { Container, MouseRegion, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createWidthCache, gutterWrapRows } from "./cc-rows.ts";
import { PrototypeMethodAdapter } from "./pi-proto-adapter.ts";

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

/** Centralized lifecycle (spec 8.3): same rules as the compaction row. */
const skillRowAdapter = new PrototypeMethodAdapter({
	proto: SkillInvocationMessageComponent.prototype,
	method: "updateDisplay",
	marker: "__ccSkillRowPatched",
	hostMatches: (host): boolean =>
		typeof (host as SkillInvocationProto)?.setBgFn === "function"
		&& typeof (host as SkillInvocationProto)?.clear === "function"
		&& typeof (host as SkillInvocationProto)?.addChild === "function"
		&& typeof (host as SkillInvocationProto)?.setExpanded === "function",
	body: (host, fg) => {
		const self = host as unknown as SkillInvocationProto;
		// Strip the Box chrome: no customMessageBg, no 1x1 padding — the row
		// must sit flush in the transcript like the CC tool rows.
		self.setBgFn(undefined);
		self.paddingX = 0;
		self.paddingY = 0;
		self.clear();
		const name = self.skillBlock?.name ?? "";
		const expanded = !!self.expanded;
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
			// Skill body as ONE guttered block — the layout itself is cc-rows'
			// gutterWrapRows (single ⤿ on the first physical row, 5-space
			// continuations) with the same wrap-once width cache, so the block
			// stays byte-consistent with the ccResult family by construction.
			const lines = (self.skillBlock?.content ?? "").replace(/\n+$/, "").split("\n");
			const bodyCache = createWidthCache();
			content.addChild({
				invalidate() {
					bodyCache.clear();
				},
				render(width: number): string[] {
					return bodyCache.serve(width, (w) =>
						gutterWrapRows(lines.map((l) => fg("toolOutput", l)), w, fg("dim", GUTTER)));
				},
			});
		}
		// Re-arm the native click-to-expand (the compaction patch drops its
		// MouseRegion; the skill row always had one, keep the behavior).
		// Native structure: the content is added ONCE, wrapped in the region.
		self.addChild(new MouseRegion(content, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			self.setExpanded(!self.expanded);
			return { handled: true };
		}));
	},
});

/** Apply (first call) or refresh the getter (re-enable / reload). */
export function patchSkillRow(getFg: () => ThemeFg | null): void {
	skillRowAdapter.apply(getFg);
}

/** Withdraw — only while our wrapper is still the installed method. */
export function restoreSkillRow(): void {
	skillRowAdapter.restore();
}
