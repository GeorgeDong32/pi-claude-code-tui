/**
 * Skill ORDER patch tests (spec 2026-10-22): an expanded skill invocation
 * must render CC-style — user bubble FIRST with the full typed
 * "/skill:name args" text, then the ⏺ Skill(name) row — instead of pi's
 * skill-first / args-only-bubble layout. Pure slice-table tests over duck
 * fixtures plus adapter-level tests against a stubbed original, pinning
 * the DEC-N4 exemption invariants: args passthrough, single original call,
 * swallow-on-native-failure, and flat ctrl+o reachability of the skill row.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { initTheme, InteractiveMode, SkillInvocationMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import {
	createSkillOrderPatch,
	isSkillInvocationNode,
	isUserMessageNode,
	reorderAppendedSkillBlock,
	type UserBubbleFactory,
} from "../extensions/lib/cc-skill-order.ts";

// The Markdown inside UserMessageComponent reads the global theme.
initTheme(undefined as unknown as string);

// ---------------------------------------------------------------- fixtures

const spacer = (): unknown => ({ lines: 1, invalidate() {}, render(): string[] { return [""]; } });

const skillNode = (name: string, userMessage?: string): unknown => ({
	skillBlock: { name, ...(userMessage === undefined ? {} : { userMessage }) },
	setExpanded(_: boolean) {},
});

const userNode = (text: string) => {
	const node = {
		text,
		rebuilds: 0,
		rebuild() {
			node.rebuilds += 1;
		},
	};
	return node;
};

const identity = (rows: unknown[]): unknown[] => rows;

// ------------------------------------------------------------ table tests

test("with-args slice [skill, spacer, user] reorders to user-first and prefixes the typed command", () => {
	const skill = skillNode("diagnosing-bugs", "测试");
	const sp = spacer();
	const user = userNode("测试");
	const children = [spacer(), skill, sp, user]; // len-4 slice after a lead spacer
	assert.equal(reorderAppendedSkillBlock(children, 1), true);
	assert.deepEqual(identity(children), [children[0], user, sp, skill]);
	assert.equal(user.text, "/skill:diagnosing-bugs 测试");
	assert.equal(user.rebuilds, 1);
	assert.equal((skill as { __ccSkillOrderApplied?: boolean }).__ccSkillOrderApplied, true);
});

test("with-args slice without lead spacer (empty chat) reorders too", () => {
	const skill = skillNode("a", "x");
	const sp = spacer();
	const user = userNode("x");
	const children = [skill, sp, user];
	assert.equal(reorderAppendedSkillBlock(children, 0), true);
	assert.deepEqual(identity(children), [user, sp, skill]);
	assert.equal(user.text, "/skill:a x");
});

test("multi-word / slash-carrying args reconstruct verbatim (normalized single space)", () => {
	const skill = skillNode("grilling", "/skill:b why?");
	const user = userNode("/skill:b why?");
	const children = [skill, spacer(), user];
	assert.equal(reorderAppendedSkillBlock(children, 0), true);
	assert.equal(user.text, "/skill:grilling /skill:b why?");
});

test("no-args slice [skill] synthesizes the user bubble + spacer before the skill row", () => {
	const made: string[] = [];
	const makeBubble: UserBubbleFactory = (text) => {
		made.push(text);
		return userNode(text);
	};
	const skill = skillNode("solo-skill");
	const children = [skill];
	assert.equal(reorderAppendedSkillBlock(children, 0, { makeUserBubble: makeBubble }), true);
	assert.deepEqual(made, ["/skill:solo-skill"]);
	const bubble = children[0] as { text: string };
	assert.equal(bubble.text, "/skill:solo-skill");
	assert.equal(children.length, 3);
	assert.equal(children[2], skill);
	// Spacer-like separator between bubble and skill row.
	assert.ok(typeof (children[1] as { lines?: unknown }).lines === "number");
});

test("no-args slice with lead spacer keeps the lead first", () => {
	const lead = spacer();
	const skill = skillNode("s");
	const children = [lead, skill];
	assert.equal(reorderAppendedSkillBlock(children, 0, { makeUserBubble: (t) => userNode(t) }), true);
	assert.equal(children[0], lead);
	assert.equal(children[3], skill);
	assert.equal((children[1] as { text: string }).text, "/skill:s");
});

test("plain user / assistant / mismatched slices stay native", () => {
	const plain = [spacer(), userNode("hello")];
	assert.equal(reorderAppendedSkillBlock(plain, 0), false);
	assert.equal(plain.length, 2);

	const assistantIsh = [{ streaming: true }, spacer(), userNode("x")];
	assert.equal(reorderAppendedSkillBlock(assistantIsh, 0), false);

	const mismatch = [skillNode("a", "x"), spacer(), userNode("y")];
	assert.equal(reorderAppendedSkillBlock(mismatch, 0), false);
	assert.equal(mismatch.length, 3);

	const alreadyPrefixed = [skillNode("a", "x"), spacer(), userNode("/skill:a x")];
	assert.equal(reorderAppendedSkillBlock(alreadyPrefixed, 0), false);
});

test("marked no-args skill never gets a second bubble (re-entry guard)", () => {
	const skill = skillNode("s");
	(skill as { __ccSkillOrderApplied?: boolean }).__ccSkillOrderApplied = true;
	const children = [skill];
	assert.equal(reorderAppendedSkillBlock(children, 0, { makeUserBubble: (t) => userNode(t) }), false);
	assert.equal(children.length, 1);
});

test("empty slice (append appended nothing) is a no-op", () => {
	const children = [spacer(), userNode("hi")];
	assert.equal(reorderAppendedSkillBlock(children, children.length), false);
	assert.equal(children.length, 2);
});

test("throwing / null bubble factory keeps native layout without propagating", () => {
	const boom: UserBubbleFactory = () => {
		throw new Error("boom");
	};
	const children = [skillNode("s")];
	assert.equal(reorderAppendedSkillBlock(children, 0, { makeUserBubble: boom }), false);
	assert.equal(children.length, 1);

	const nullish: UserBubbleFactory = () => null;
	assert.equal(reorderAppendedSkillBlock(children, 0, { makeUserBubble: nullish }), false);
	assert.equal(children.length, 1);
});

test("second pass over an already-reordered slice does not double-prefix", () => {
	const skill = skillNode("a", "x");
	const user = userNode("x");
	const children = [skill, spacer(), user];
	assert.equal(reorderAppendedSkillBlock(children, 0), true);
	const reordered = [...children];
	assert.equal(reorderAppendedSkillBlock(children, 0), false); // shapes no longer match
	assert.deepEqual(identity(children), reordered);
	assert.equal(user.text, "/skill:a x");
	assert.equal(user.rebuilds, 1);
});

// ------------------------------------------------------ duck-type guards

test("duck guards reject non-nodes", () => {
	assert.equal(isSkillInvocationNode(null), false);
	assert.equal(isSkillInvocationNode(42), false);
	assert.equal(isSkillInvocationNode({ skillBlock: { name: "x" } }), false); // no setExpanded
	assert.equal(isSkillInvocationNode({ setExpanded() {} }), false); // no skillBlock
	assert.equal(isUserMessageNode(null), false);
	assert.equal(isUserMessageNode({ text: "x" }), false); // no rebuild
	assert.equal(isUserMessageNode({ rebuild() {} }), false); // no text
});

// ------------------------------------------------------- adapter level

interface Recorder {
	calls: Array<{ args: unknown[] }>;
	appended: unknown[];
	throwAfterAppend: boolean;
}

const makeProtoAndHost = () => {
	const rec: Recorder = { calls: [], appended: [], throwAfterAppend: false };
	// Records via closure (not `this`) so even a hostile host can't break the
	// stub, and reads chatContainer defensively for the shape-mismatch case.
	const proto = {
		addMessageToChat(this: { chatContainer?: { children: unknown[] } }, ...args: unknown[]): void {
			rec.calls.push({ args });
			for (const node of rec.appended) this.chatContainer?.children.push(node);
			if (rec.throwAfterAppend) throw new Error("native boom");
		},
	};
	const host = {
		chatContainer: { children: [] as unknown[] },
		outputPad: 1,
	};
	return { proto, host, rec };
};

test("adapter forwards message + options verbatim to the original, exactly once", () => {
	const { proto, host, rec } = makeProtoAndHost();
	const patch = createSkillOrderPatch(proto);
	patch.apply();
	const message = { role: "user", content: "x" };
	const options = { populateHistory: true };
	(proto as { addMessageToChat: (...a: unknown[]) => void }).addMessageToChat.call(host, message, options);
	assert.equal(rec.calls.length, 1);
	assert.deepEqual(rec.calls[0].args, [message, options]);
	patch.restore();
});

test("original throwing is swallowed: no propagation, no replay, partial native rows stay", () => {
	const { proto, host, rec } = makeProtoAndHost();
	const patch = createSkillOrderPatch(proto);
	patch.apply();
	rec.appended = [skillNode("s")];
	rec.throwAfterAppend = true;
	const call = () =>
		(proto as { addMessageToChat: (...a: unknown[]) => void }).addMessageToChat.call(host, { role: "user" });
	assert.doesNotThrow(call); // DEC-N4 exemption: swallow, never propagate
	assert.equal(rec.calls.length, 1); // degrade replay never fired
	assert.equal(host.chatContainer.children.length, 1); // partial native row kept (no rollback)
	patch.restore();
});

test("host shape mismatch degrades to a single original call with no reorder", () => {
	const { proto, rec } = makeProtoAndHost();
	const patch = createSkillOrderPatch(proto);
	patch.apply();
	const badHost = { noChatHere: true } as never;
	(proto as { addMessageToChat: (...a: unknown[]) => void }).addMessageToChat.call(badHost, { role: "user" });
	assert.equal(rec.calls.length, 1); // adapter degrade ran the original once
	patch.restore();
});

test("getMarkdownThemeWithSettings throwing keeps native layout, original called once (post-original totality)", () => {
	const { proto, rec } = makeProtoAndHost();
	const patch = createSkillOrderPatch(proto);
	patch.apply();
	const host = {
		chatContainer: { children: [] as unknown[] },
		outputPad: 1,
		getMarkdownThemeWithSettings() {
			throw new Error("theme boom");
		},
		getMarkdownTransformers: () => [],
	};
	rec.appended = [skillNode("solo")];
	const call = () =>
		(proto as { addMessageToChat: (...a: unknown[]) => void }).addMessageToChat.call(host, { role: "user" });
	assert.doesNotThrow(call);
	assert.equal(rec.calls.length, 1);
	assert.equal(host.chatContainer.children.length, 1); // untouched: skill row only
	patch.restore();
});

// ----------------------------------------------- real components + walk

test("real components: reordered slice renders and the skill row stays reachable by the flat ctrl+o walk", () => {
	const block = {
		name: "diagnosing-bugs",
		location: "/home/u/.pi/agent/skills/dbg/SKILL.md",
		content: "Run the diagnosis loop.",
		userMessage: "测试",
	} as never;
	const skill = new SkillInvocationMessageComponent(block, {} as never);
	const user = new UserMessageComponent("测试", {} as never);
	const children: unknown[] = [skill, spacer(), user];
	assert.equal(reorderAppendedSkillBlock(children, 0), true);
	// Order + prefix text on the real bubble.
	assert.equal(children[0], user);
	assert.equal(children[2], skill);
	assert.equal((user as unknown as { text: string }).text, "/skill:diagnosing-bugs 测试");
	// The bubble still renders (markdown path) and shows the typed command.
	const rendered = user.render(80).map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, ""));
	assert.ok(rendered.some((l) => l.includes("/skill:diagnosing-bugs")));
	// Flat walk (setToolsExpanded walks chatContainer.children one level).
	let expandedCount = 0;
	for (const node of children) {
		const maybe = node as { setExpanded?: (e: boolean) => void };
		if (typeof maybe.setExpanded === "function") {
			maybe.setExpanded(true);
			expandedCount += 1;
		}
	}
	assert.equal(expandedCount, 1); // only the skill row is expandable
	assert.equal((skill as unknown as { expanded: boolean }).expanded, true);
});

// ── real prototype end-to-end (N-T5b precedent: upgrade canary + full path) ──

test("real prototype: native addMessageToChat renders CC order under the patch; restore is reference-equal", () => {
	assert.equal(typeof InteractiveMode, "function", "InteractiveMode exported from the package root");
	// addMessageToChat is private in pi's d.ts — reach it through a typed view.
	const protoView = InteractiveMode.prototype as unknown as {
		addMessageToChat?: (...args: unknown[]) => void;
	};
	assert.equal(typeof protoView?.addMessageToChat, "function");
	// Upgrade canary: the method still takes (message, options).
	assert.equal(protoView.addMessageToChat?.length, 2);

	const saved = protoView.addMessageToChat;
	const patch = createSkillOrderPatch(InteractiveMode.prototype as unknown as object);
	patch.apply();
	try {
		// Borrow the real sibling helpers so the native user branch runs its
		// genuine path (N-T5b's showError needed none; this one does).
		const protoAny = InteractiveMode.prototype as unknown as Record<string, unknown>;
		const host = {
			chatContainer: new Container(),
			toolOutputExpanded: false,
			outputPad: 1,
			getUserMessageText: protoAny.getUserMessageText,
			getMarkdownThemeWithSettings: () => undefined,
			getMarkdownTransformers: () => [],
		} as never;
		// Exactly pi's expanded form (agent-session._expandSkillCommand).
		const expanded = '<skill name="order-skill" location="/s/SKILL.md">\nbody\n</skill>\n\nhello';
		const message = { role: "user", content: expanded };
		patchCall(protoView, host, message);
		const kids = (host as never as { chatContainer: { children: unknown[] } }).chatContainer.children;
		assert.equal(kids.length, 3, `expected [user, spacer, skill], got ${kids.length}`);
		assert.ok(isUserMessageNode(kids[0]), "bubble first");
		assert.equal((kids[0] as { text: string }).text, "/skill:order-skill hello");
		assert.ok(isSkillInvocationNode(kids[2]), "skill row last");
		assert.equal((kids[2] as { skillBlock: { name: string } }).skillBlock.name, "order-skill");
	} finally {
		patch.restore();
	}
	assert.equal(protoView.addMessageToChat, saved, "restored by reference");
});

/** Invoke the (private-typed) method with a plain-this host. */
function patchCall(
	protoView: { addMessageToChat?: (...args: unknown[]) => void },
	host: never,
	message: unknown,
): void {
	protoView.addMessageToChat?.call(host, message);
}
