/**
 * CC-style skill invocation ORDER (spec 2026-10-22).
 *
 * pi renders an expanded skill (`/skill:name args`) as: skill row FIRST,
 * then an args-only user bubble — the typed "/skill:name" prefix disappears
 * and the tool row reads ABOVE the user's message (and with no args, no
 * bubble at all: the typed command leaves no trace). Claude Code keeps the
 * user bubble first with the FULL typed text, then the Skill row
 * (SkillTool/UI.tsx):
 *
 *   ❯ /skill:diagnosing-bugs 测试
 *
 *   ⏺ Skill(diagnosing-bugs) (ctrl+o to expand)
 *
 * Wrapper patch on InteractiveMode.addMessageToChat — the single choke
 * point for both initial history render and incremental message_start
 * appends. After the original runs, THIS call's appended slice
 * children[before..after) is reordered:
 *
 *   with args: [lead?, skill, spacer, user] → [lead?, user("/skill:name args"), spacer, skill]
 *   no args:   [lead?, skill]               → [lead?, user("/skill:name"), spacer(1), skill]
 *
 * (the no-args bubble is synthesized — pi renders no user bubble there.)
 *
 * DEC-N4 EXEMPTION (documented in pi-proto-adapter.ts too): this body MUST
 * work after the original (it reorders what the original appended), so it
 * cannot follow "original call last". The invariant is preserved by
 * (a) swallowing the original's own failure instead of propagating it and
 * (b) making every post-original step total (reorderAppendedSkillBlock
 * swallows internally). The adapter's outer catch is therefore unreachable
 * once the original ran — its degrade replay can never duplicate a
 * successful append. No rollback on native failure: partial native lines
 * stay (native behavior), and a throwing rollback would itself be the one
 * path to a replay double-append.
 *
 * Display layer only: the transcript entry keeps pi's expanded skill-block
 * text; the model never sees a difference. Multi-skill expansion semantics
 * (leading /skill: only) are pi core and stay untouched.
 */
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Spacer } from "@earendil-works/pi-tui";
import { PrototypeMethodAdapter } from "./pi-proto-adapter.ts";

// Duck shapes only — jiti's moduleCache:false can hand us a second module
// instance where instanceof fails (AGENTS trap 4).
interface SkillInvocationNode {
	skillBlock: { name: string; userMessage?: string };
	setExpanded?: unknown;
	/** Instance marker: this skill row already went through a reorder pass. */
	__ccSkillOrderApplied?: boolean;
}

interface UserMessageNode {
	text: string;
	rebuild(): void;
}

/** Native SkillInvocationMessageComponent shape (skillBlock + setExpanded). */
export function isSkillInvocationNode(node: unknown): node is SkillInvocationNode {
	if (node === null || typeof node !== "object") return false;
	const block = (node as { skillBlock?: unknown }).skillBlock;
	return (
		typeof block === "object"
		&& block !== null
		&& typeof (block as { name?: unknown }).name === "string"
		&& typeof (node as { setExpanded?: unknown }).setExpanded === "function"
	);
}

/** Native UserMessageComponent shape (text + rebuild). */
export function isUserMessageNode(node: unknown): node is UserMessageNode {
	if (node === null || typeof node !== "object") return false;
	return (
		typeof (node as { text?: unknown }).text === "string"
		&& typeof (node as { rebuild?: unknown }).rebuild === "function"
	);
}

/** Builds the no-args user bubble; null / throw = keep native layout. */
export type UserBubbleFactory = (text: string) => UserMessageNode | null;

interface SkillOrderDeps {
	makeUserBubble?: UserBubbleFactory;
}

/**
 * Rewrite one appended slice. Returns the replacement rows, or null when the
 * slice is not a native skill append (leave children untouched). Never
 * throws outward beyond what callers already swallow.
 */
function rewriteSkillSlice(slice: unknown[], deps: SkillOrderDeps): unknown[] | null {
	const n = slice.length;
	// with-args: [lead?, skill, x, user] — identity via user.text ===
	// skillBlock.userMessage also makes a second pass over the same nodes a
	// no-match (text already carries the /skill: prefix).
	if (n >= 3) {
		const user = slice[n - 1];
		const skill = slice[n - 3];
		if (isUserMessageNode(user) && isSkillInvocationNode(skill)) {
			const userMessage = skill.skillBlock.userMessage;
			if (typeof userMessage === "string" && userMessage.length > 0 && user.text === userMessage) {
				const previous = user.text;
				user.text = `/skill:${skill.skillBlock.name} ${user.text}`;
				try {
					user.rebuild(); // flows through the userBar patch like native rebuilds
				} catch {
					user.text = previous; // keep render consistent with the stale children
				}
				skill.__ccSkillOrderApplied = true;
				return [...slice.slice(0, n - 3), user, slice[n - 2], skill];
			}
		}
	}
	// no-args: [lead?, skill] — pi renders no user bubble at all; synthesize
	// the CC one from the typed command shape. The instance marker guards
	// against any pathological re-entry injecting a second bubble.
	if (n >= 1) {
		const skill = slice[n - 1];
		if (
			isSkillInvocationNode(skill)
			&& !skill.__ccSkillOrderApplied
			&& (skill.skillBlock.userMessage ?? "") === ""
		) {
			const bubble = deps.makeUserBubble?.(`/skill:${skill.skillBlock.name}`) ?? null;
			if (bubble === null) return null;
			skill.__ccSkillOrderApplied = true;
			return [...slice.slice(0, n - 1), bubble, new Spacer(1), skill];
		}
	}
	return null;
}

/**
 * Reorder the slice this addMessageToChat call appended:
 * children[before..length). Returns true when the slice was rewritten.
 * Total: any internal failure leaves the native layout in place.
 */
export function reorderAppendedSkillBlock(
	children: unknown[],
	before: number,
	deps: SkillOrderDeps = {},
): boolean {
	try {
		const after = children.length;
		if (after <= before) return false;
		const slice = children.slice(before, after);
		const rewritten = rewriteSkillSlice(slice, deps);
		if (rewritten === null) return false;
		children.splice(before, after - before, ...rewritten);
		return true;
	} catch {
		return false; // native order stays
	}
}

export interface SkillOrderPatch {
	apply(): void;
	restore(): void;
}

/**
 * Wrap InteractiveMode.prototype.addMessageToChat (DEC-N11: the entry
 * checks the method exists before calling this factory). See the module
 * header for the DEC-N4 exemption this body relies on.
 */
export function createSkillOrderPatch(proto: object): SkillOrderPatch {
	const adapter = new PrototypeMethodAdapter({
		proto,
		method: "addMessageToChat",
		marker: "__ccSkillOrder",
		hostMatches: (host): boolean =>
			Array.isArray((host as { chatContainer?: { children?: unknown } }).chatContainer?.children),
		body: (host, _fg, original, args) => {
			const children = (host as { chatContainer: { children: unknown[] } }).chatContainer.children;
			const before = children.length;
			try {
				original?.apply(host, [...args]);
			} catch {
				// DEC-N4 exemption: swallow the native failure — the adapter's
				// degrade path would replay the append (double chat append).
				return;
			}
			// Total by construction: every post-original step swallows inside.
			reorderAppendedSkillBlock(children, before, {
				makeUserBubble: (text) => {
					const host_ = host as {
						getMarkdownThemeWithSettings?: () => unknown;
						outputPad?: unknown;
						getMarkdownTransformers?: () => unknown;
					};
					try {
						return new UserMessageComponent(
							text,
							host_.getMarkdownThemeWithSettings?.() as ConstructorParameters<
								typeof UserMessageComponent
							>[1],
							typeof host_.outputPad === "number" ? host_.outputPad : 1,
							(host_.getMarkdownTransformers?.() ?? []) as ConstructorParameters<
								typeof UserMessageComponent
							>[3],
						) as unknown as UserMessageNode;
					} catch {
						return null; // keep native layout (skill row only)
					}
				},
			});
		},
	});
	return {
		apply(): void {
			adapter.apply(() => null);
		},
		restore(): void {
			adapter.restore();
		},
	};
}
