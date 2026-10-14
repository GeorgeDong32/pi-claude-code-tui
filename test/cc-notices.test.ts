/**
 * cc-notices table tests (spec 2026-10-13-cc-notices §4):
 *
 * N-T2 compactNotice (DEC-N3), N-T3 center modes/merge/capacity (DEC-N5),
 * N-T4 singleton, N-T5 taps on a fake host class, N-T5b taps on the REAL
 * InteractiveMode prototype + upgrade canary, N-T6 entry rows golden +
 * click-override semantics, N-T7 chip, N-T8 fatal-exit dump (DEC-N9).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import {
	buildNoticeSnapshot,
	compactNotice,
	createNoticeCenter,
	createNoticeExpansionTracker,
	createNoticeTaps,
	extractActionPointer,
	installFatalExitDump,
	noticeChip,
	noticeEntryRows,
	sharedNoticeCenter,
	type NoticeCenter,
} from "../extensions/lib/cc-notices.ts";

const theme = {
	fg: (c: string, s: string) => `[${c}]${s}[/${c}]`,
	bold: (s: string) => `[b]${s}[/b]`,
};
const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

const makeCenter = (columns = 100, capacity?: number): NoticeCenter =>
	createNoticeCenter({ now: () => 1_000, columns: () => columns, ...(capacity !== undefined ? { capacity } : {}) });

// ── N-T2: compactNotice ──────────────────────────────────────────────────

test("N-T2 compactNotice: short single line → null (passthrough)", () => {
	assert.equal(compactNotice("Unknown thinking level \"foo\"", 80), null);
});

test("N-T2 compactNotice: multi-line → first non-empty line + pointer", () => {
	const out = compactNotice("\n\n  models.json error: boom  \nFile:\n/some/path", 80);
	assert.ok(out !== null);
	assert.ok(out.startsWith("models.json error: boom · /notice"), `got ${JSON.stringify(out)}`);
	assert.ok(!out.includes("\n"), "one physical line");
});

test("N-T2 compactNotice: long single line → truncated + pointer", () => {
	const long = "x".repeat(200);
	const out = compactNotice(long, 40);
	assert.ok(out !== null);
	assert.ok(out!.endsWith(" · /notice"));
	assert.ok(out!.includes("…"), "ellipsis marker");
});

test("N-T2 compactNotice: empty / whitespace-only → null", () => {
	assert.equal(compactNotice("", 80), null);
	assert.equal(compactNotice("   \n  \n ", 80), null);
});

test("N-T2 compactNotice: CJK width counts double", () => {
	const wide = "错".repeat(30); // 60 columns > budget 40 → must truncate
	const out = compactNotice(wide, 40);
	assert.ok(out !== null && out!.includes("…"));
	const fit = "错".repeat(10); // 20 columns ≤ 40 → passthrough
	assert.equal(compactNotice(fit, 40), null);
});

test("N-T2 compactNotice: budget floor 40", () => {
	// budget 10 → floor 40 applies; a 25-col line fits and passes through.
	assert.equal(compactNotice("a".repeat(25), 10), null);
	// 50-col line exceeds the floored budget → compacted.
	assert.ok(compactNotice("a".repeat(50), 10) !== null);
});

test("N-T2 extractActionPointer: last Run/Use command wins; /notice never routes to itself", () => {
	assert.equal(extractActionPointer("MCP servers need attention:\n  foo: needs sign-in\nRun /mcp to fix."), "/mcp");
	assert.equal(extractActionPointer("Use /mcp to authenticate."), "/mcp");
	assert.equal(extractActionPointer("run /reload now"), "/reload");
	assert.equal(extractActionPointer("nothing here"), null);
	assert.equal(extractActionPointer("Run /notice to view"), null);
	assert.equal(extractActionPointer("see https://example.com/x"), null);
	assert.equal(extractActionPointer("Run /a first\nRun /b last"), "/b");
});

test("N-T2 compactNotice: routed pointer replaces the generic one; the pointer never truncates", () => {
	const msg = "MCP servers need attention:\n  foo: needs sign-in\nRun /mcp to fix.";
	const out = compactNotice(msg, 200, extractActionPointer(msg) ?? "/notice");
	assert.ok(out !== null);
	assert.ok(out.startsWith("MCP servers need attention:"), JSON.stringify(out));
	assert.ok(out.endsWith(" · /mcp"), JSON.stringify(out));
	const tightMsg = "MCP servers need attention:\nRun /verylongcommandname to fix.";
	const tight = compactNotice(tightMsg, 40, extractActionPointer(tightMsg) ?? "/notice");
	assert.ok(tight !== null && tight.endsWith(" · /verylongcommandname"), JSON.stringify(tight));
});

// ── N-T3: center ─────────────────────────────────────────────────────────

test("N-T3 center: compact routes the message's own action pointer (MCP → /mcp)", () => {
	const c = makeCenter(200);
	const msg = "MCP servers need attention:\n  foo: needs sign-in\nRun /mcp to fix.";
	const out = c.intercept("warning", msg, 1);
	assert.ok(out !== null && out.endsWith(" · /mcp"), JSON.stringify(out));
	assert.equal(c.snapshot()[0]!.altered, true);
});

test("N-T3 center: compact rewrites long messages, passthrough returns the SAME string", () => {
	const c = makeCenter(100);
	const msg = ["first line of a very long error", "File:", "/deep/path"].join("\n");
	const out = c.intercept("error", msg, 1);
	assert.ok(out !== null && out !== msg && out.includes("· /notice"));
	assert.equal(c.intercept("error", "short one", 1), "short one");
	const rec = c.snapshot()[0]!;
	assert.equal(rec.altered, true, "compacted occurrence is altered");
	const rec2 = c.snapshot()[1]!;
	assert.equal(rec2.altered, false, "passthrough occurrence is not altered");
});

test("N-T3 center: quiet returns null, off passthrough — setMode is immediate", () => {
	const c = makeCenter(100);
	c.setMode("quiet");
	assert.equal(c.intercept("warning", "hello", 1), null);
	assert.deepEqual(c.unread(), { errors: 0, warnings: 1 });
	c.setMode("off");
	assert.equal(c.intercept("warning", "hello", 1), "hello");
	assert.equal(c.mode(), "off");
});

test("N-T3 center: identical level+message merges ×N, refreshes at", () => {
	const c = makeCenter(100);
	c.intercept("error", "same", 1);
	c.intercept("error", "same", 1);
	c.intercept("error", "same", 1);
	const snap = c.snapshot();
	assert.equal(snap.length, 1);
	assert.equal(snap[0]!.count, 3);
});

test("N-T3 center: merging into a READ record resets viewed (S7)", () => {
	const c = makeCenter(100);
	c.setMode("quiet");
	c.intercept("error", "same", 1);
	assert.deepEqual(c.unread(), { errors: 1, warnings: 0 });
	c.markRead();
	assert.deepEqual(c.unread(), { errors: 0, warnings: 0 });
	c.intercept("error", "same", 1); // merged repeat, new occurrence unseen
	assert.deepEqual(c.unread(), { errors: 1, warnings: 0 }, "merged repeat must be unread again");
});

test("N-T3 center: capacity drops the oldest", () => {
	const c = makeCenter(100, 2);
	c.intercept("error", "a", 1);
	c.intercept("error", "b", 1);
	c.intercept("error", "c", 1);
	const snap = c.snapshot();
	assert.equal(snap.length, 2);
	assert.equal(snap[0]!.message, "b");
	assert.equal(snap[1]!.message, "c");
});

test("N-T3 center: passthrough records exist but never count unread; markRead/clear", () => {
	const c = makeCenter(100);
	c.intercept("error", "plain short", 1);
	assert.deepEqual(c.unread(), { errors: 0, warnings: 0 });
	assert.equal(c.snapshot().length, 1);
	c.markRead();
	c.clear();
	assert.equal(c.snapshot().length, 0);
});

test("N-T3 center: error budget honors padX, warning is fixed at 1 (S8)", () => {
	// budget = columns − 2·padX − len("Error: ") − len(" · /notice")
	//        = 100 − 2·padX − 7 − 18
	const a = makeCenter(100);
	assert.ok(a.intercept("error", "m".repeat(95), 3) !== null, "padX 3 → budget 69 < 95 → compacted");
	const b = makeCenter(100);
	const msg = "y".repeat(70); // budget at padX 1 = 73 → passthrough
	assert.equal(b.intercept("error", msg, 1), msg);
	const d = makeCenter(100);
	assert.ok(d.intercept("error", msg, 8) !== null, "padX 8 → budget 59 < 70 → compacted");
});

// ── N-T4: singleton ──────────────────────────────────────────────────────

test("N-T4 sharedNoticeCenter: stable identity across calls", () => {
	assert.strictEqual(sharedNoticeCenter(), sharedNoticeCenter());
});

test("N-T4 sharedNoticeCenter: foreign/incompatible slot object is replaced", () => {
	const sym = Symbol.for("pi-claude-code-tui/notices");
	const prev = (globalThis as Record<symbol, unknown>)[sym];
	(globalThis as Record<symbol, unknown>)[sym] = { v: 99, center: {} };
	const c = sharedNoticeCenter();
	const slot = (globalThis as Record<symbol, unknown>)[sym] as { v: number; center: NoticeCenter };
	assert.equal(slot.v, 1, "incompatible slot was replaced");
	assert.strictEqual(slot.center, c);
	assert.strictEqual(sharedNoticeCenter(), c, "stable again after replacement");
	if (prev !== undefined) (globalThis as Record<symbol, unknown>)[sym] = prev;
});

// ── N-T5: taps on a fake host ────────────────────────────────────────────

class FakeHost {
	outputPad = 2;
	ui = { renders: 0, requestRender() { this.renders += 1; } };
	shown: string[] = [];
	showError(message: string): void {
		this.shown.push(`E:${message}`);
	}
	showWarning(message: string): void {
		this.shown.push(`W:${message}`);
	}
}

const makeFakeHost = (): FakeHost => new FakeHost();

const multiLine = (fill = "detail"): string => `boom top line\n${fill}\n${fill}`;

test("N-T5 tap: compact rewrites the argument, passthrough keeps it identical", () => {
	const center = makeCenter(100);
	const taps = createNoticeTaps(FakeHost.prototype as never as object, {
		center: () => center,
		repaint: () => {},
	});
	taps.apply();
	try {
		const host = makeFakeHost();
		host.showError(multiLine());
		assert.equal(host.shown.length, 1);
		assert.ok(host.shown[0]!.startsWith("E:boom top line · /notice"), `got ${host.shown[0]}`);
		const same = "identical";
		host.showWarning(same);
		assert.equal(host.shown[1], `W:${same}`);
	} finally {
		taps.restore();
	}
});

test("N-T5 tap: quiet never calls the original; host repaint first, deps.repaint fallback", () => {
	const center = makeCenter(100);
	center.setMode("quiet");
	let repaints = 0;
	const taps = createNoticeTaps(FakeHost.prototype as never as object, {
		center: () => center,
		repaint: () => {
			repaints += 1;
		},
	});
	taps.apply();
	try {
		const host = makeFakeHost();
		host.showError("quiet me");
		assert.equal(host.shown.length, 0, "original must not run in quiet");
		assert.equal(host.ui.renders, 1, "host ui.requestRender called exactly once");
		assert.equal(repaints, 0, "fallback repaint not used when host has ui");

		// No `ui` on this host (prototype method still ours — no own shadow):
		// falls back to deps.repaint.
		const bare = makeFakeHost();
		(bare as unknown as { ui: unknown }).ui = undefined;
		bare.showError("no ui here");
		assert.equal(bare.shown.length, 0);
		assert.equal(repaints, 1);
	} finally {
		taps.restore();
	}
});

test("N-T5 tap: non-string argument passes through untouched and is not recorded", () => {
	const center = makeCenter(100);
	const taps = createNoticeTaps(FakeHost.prototype as never as object, {
		center: () => center,
		repaint: () => {},
	});
	taps.apply();
	try {
		const host = makeFakeHost();
		let received: unknown;
		host.showError = function (this: FakeHost, message: string) {
			received = message;
		};
		const evil = { toString: () => "stringified" } as unknown as string;
		host.showError(evil);
		assert.strictEqual(received, evil, "the SAME object reaches the original, never String()-coerced");
		assert.equal(center.snapshot().length, 0, "non-string never recorded");
	} finally {
		taps.restore();
	}
});

test("N-T5 tap: error padX reads host.outputPad; warning fixed at 1", () => {
	const center = makeCenter(100);
	const taps = createNoticeTaps(FakeHost.prototype as never as object, {
		center: () => center,
		repaint: () => {},
	});
	taps.apply();
	try {
		const host = makeFakeHost(); // outputPad = 2
		host.showWarning("w".repeat(60)); // warning budget = 73 → passthrough
		assert.equal(host.shown[0], `W:${"w".repeat(60)}`);
		host.showError("z".repeat(60)); // error budget = 100-4-7-18 = 71 → passthrough too
		assert.equal(host.shown[1], `E:${"z".repeat(60)}`);
		host.showError("q".repeat(95)); // error budget 71 < 95 → compacted, reads outputPad=2
		assert.ok(host.shown[2]!.includes("· /notice"));
	} finally {
		taps.restore();
	}
});

test("N-T5 tap: off mode passes through; restore returns the native methods", () => {
	const center = makeCenter(100);
	center.setMode("off");
	const nativeError = FakeHost.prototype.showError;
	const nativeWarning = FakeHost.prototype.showWarning;
	const taps = createNoticeTaps(FakeHost.prototype as never as object, {
		center: () => center,
		repaint: () => {},
	});
	taps.apply();
	const host = makeFakeHost();
	host.showError(multiLine());
	assert.equal(host.shown[0], `E:${multiLine()}`, "off = verbatim passthrough");
	taps.restore();
	assert.equal(FakeHost.prototype.showError, nativeError);
	assert.equal(FakeHost.prototype.showWarning, nativeWarning);
});

test("N-T5 tap: body throw degrades to the original with original args", () => {
	const center = makeCenter(100);
	// A poisoned center that explodes inside intercept.
	const poisoned: NoticeCenter = {
		...center,
		intercept: () => {
			throw new Error("center exploded");
		},
	};
	const taps = createNoticeTaps(FakeHost.prototype as never as object, {
		center: () => poisoned,
		repaint: () => {},
	});
	taps.apply();
	try {
		const host = makeFakeHost();
		host.showError("keep me");
		assert.deepEqual(host.shown, ["E:keep me"], "fail-open to the native full text");
	} finally {
		taps.restore();
	}
});

test("N-T5 tap: missing methods are not wrapped (install guard shape)", () => {
	// PrototypeMethodAdapter with a missing method stores original=undefined;
	// createNoticeTaps is only invoked by the entry when both methods exist.
	// Here we verify the defensive non-string branch on a proto without the
	// methods: nothing throws either way.
	const empty = {} as object;
	const taps = createNoticeTaps(empty, { center: () => makeCenter(100), repaint: () => {} });
	taps.apply();
	taps.restore();
	assert.ok(true);
});

// ── N-T5b: the real prototype ────────────────────────────────────────────

test("N-T5b real prototype: taps render a one-line summary into a real Container; restore is reference-equal", () => {
	assert.equal(typeof InteractiveMode, "function", "InteractiveMode exported from the package root");
	assert.equal(typeof InteractiveMode.prototype.showError, "function");
	assert.equal(typeof InteractiveMode.prototype.showWarning, "function");
	// Upgrade canary: the methods still take exactly one argument.
	assert.equal(InteractiveMode.prototype.showError.length, 1);
	assert.equal(InteractiveMode.prototype.showWarning.length, 1);

	// ThemedText builds via the live theme module — initialize it first.
	try {
		initTheme("default", false);
	} catch {
		// already initialized (or name unknown) — fine for rendering
	}

	const center = createNoticeCenter({ now: () => 5, columns: () => 120 });
	const savedError = InteractiveMode.prototype.showError;
	const savedWarning = InteractiveMode.prototype.showWarning;
	const taps = createNoticeTaps(InteractiveMode.prototype, {
		center: () => center,
		repaint: () => {},
	});
	taps.apply();
	try {
		const host = {
			chatContainer: new Container(),
			ui: { requestRender() {} },
			outputPad: 1,
		} as never;
		(InteractiveMode.prototype.showError as (this: never, m: string) => void).call(host, multiLine("real"));
		const lines = (host as never as { chatContainer: Container }).chatContainer.render(120);
		const text = lines.join("\n");
		assert.ok(text.includes("boom top line · /notice"), `summary rendered: ${JSON.stringify(lines)}`);
		assert.ok(!text.includes("real"), "detail lines are gone in compact mode");
		assert.equal(center.snapshot().length, 1);
	} finally {
		taps.restore();
	}
	assert.equal(InteractiveMode.prototype.showError, savedError, "restored by reference");
	assert.equal(InteractiveMode.prototype.showWarning, savedWarning);
});

// ── N-T6: entry rows ─────────────────────────────────────────────────────

const snap = (notices: Array<Partial<{ level: string; message: string; at: number; count: number }>>): unknown => ({
	v: 1,
	takenAt: 5,
	notices: notices.map((n) => ({
		level: n.level ?? "error",
		message: n.message ?? "msg",
		at: n.at ?? 1,
		count: n.count ?? 1,
	})),
});

test("N-T6 entry: collapsed single row — head, latest summary, hint", () => {
	// plain theme: width math must not see fake tag characters.
	const rows = noticeEntryRows(plain as never, snap([{ level: "error", message: "first\nsecond", count: 1 }, { level: "warning", message: "the latest line" }]), 100, false);
	assert.equal(rows.length, 1);
	const visible = rows[0]!.replace(/\x1b\[[0-9;]*m/g, "");
	assert.ok(visible.includes("Notices(2 · 1 error · 1 warning)"), rows[0]);
	assert.ok(visible.includes("the latest line"));
	assert.ok(visible.includes("(ctrl+o to expand)"));
});

test("N-T6 entry: expanded — one guttered block per notice, ×N and dim time", () => {
	const rows = noticeEntryRows(
		plain as never,
		snap([
			{ level: "error", message: "alpha", count: 3 },
			{ level: "warning", message: "beta", count: 1 },
		]),
		100,
		true,
		(at) => `T${at}`,
	);
	assert.ok(rows.length >= 3);
	assert.ok(rows[1]!.includes("[T1] error ×3"), `lead row: ${rows[1]}`);
	assert.ok(rows[1]!.startsWith("  ⎿  "), "gutter on the first physical row");
	assert.ok(rows[2]!.startsWith("     "), "5-space continuation");
	assert.ok(rows.some((r) => r.includes("beta")));
});

test("N-T6 entry: malformed data → [], never throws", () => {
	assert.deepEqual(noticeEntryRows(theme as never, null, 80, false), []);
	assert.deepEqual(noticeEntryRows(theme as never, { v: 2, notices: [] }, 80, false), []);
	assert.deepEqual(noticeEntryRows(theme as never, { v: 1, takenAt: 1, notices: [] }, 80, false), []);
	assert.deepEqual(
		noticeEntryRows(theme as never, { v: 1, takenAt: 1, notices: [{ level: "fatal", message: "x", at: 1, count: 1 }] }, 80, false),
		[],
	);
	assert.deepEqual(
		noticeEntryRows(theme as never, { v: 1, takenAt: 1, notices: [{ level: "error", message: 7, at: 1, count: 1 }] }, 80, false),
		[],
	);
	// A throwing theme must not escape either.
	assert.deepEqual(
		noticeEntryRows({ fg: () => { throw new Error("theme"); }, bold: (s) => s }, snap([{ message: "x" }]), 80, false),
		[],
	);
});

test("N-T6 entry: narrow width truncates the collapsed row without throwing", () => {
	const rows = noticeEntryRows(plain as never, snap([{ message: "a very long summary line ".repeat(8) }]), 20, false);
	assert.equal(rows.length, 1);
});

test("N-T6 snapshot builder: 16k truncation marker (DEC-N6)", () => {
	const c = makeCenter(100);
	c.intercept("error", "x".repeat(20_000) + "\ntail", 1);
	const built = buildNoticeSnapshot(c, 7);
	assert.equal(built.v, 1);
	assert.equal(built.takenAt, 7);
	const msg = built.notices[0]!.message;
	assert.ok(msg.length < 20_100);
	assert.ok(msg.endsWith("…(truncated)"));
	// count/at survive, and altered/viewed are not persisted.
	assert.deepEqual(Object.keys(built.notices[0]!).sort(), ["at", "count", "level", "message"]);
});

// ── N-T7: chip ───────────────────────────────────────────────────────────

test("N-T7 chip: empty when nothing unread; warning color; error wins", () => {
	assert.equal(noticeChip(theme as never, { errors: 0, warnings: 0 }), "");
	assert.equal(noticeChip(theme as never, { errors: 0, warnings: 2 }), "[warning]⚠ 2 notices · /notice[/warning]");
	assert.equal(noticeChip(theme as never, { errors: 1, warnings: 2 }), "[error]⚠ 3 notices · /notice[/error]");
	assert.equal(noticeChip(theme as never, { errors: 1, warnings: 0 }), "[error]⚠ 1 notice · /notice[/error]");
});

// ── N-T8: fatal exit dump ────────────────────────────────────────────────

test("N-T8 fatal dump: code 0 silent; code 1 dumps unread full text as plain text", () => {
	const dumpSlot = Symbol.for("pi-claude-code-tui/notices-exit-dump");
	const prev = (globalThis as Record<symbol, unknown>)[dumpSlot];
	delete (globalThis as Record<symbol, unknown>)[dumpSlot];

	const center = makeCenter(100);
	center.setMode("quiet");
	center.intercept("error", "read already", 1);
	center.markRead();
	center.intercept("error", "full text one\nsecond line", 1);
	center.intercept("warning", "\x1b[31mcolored\x1b[0m warning", 1);

	const written: string[] = [];
	let handler: ((code: number) => void) | undefined;
	installFatalExitDump(() => center, (s) => written.push(s), (fn) => {
		handler = fn;
	});
	assert.ok(handler !== undefined, "registered");
	handler!(0);
	assert.equal(written.length, 0, "clean exit stays silent");
	handler!(1);
	assert.equal(written.length, 1);
	const dump = written[0]!;
	assert.ok(dump.startsWith("[claude-tui] 2 notice(s) not shown in full:"), dump);
	assert.ok(dump.includes("full text one\nsecond line"), "full multi-line text");
	assert.ok(dump.includes("colored warning") && !dump.includes("\x1b[31m"), "ANSI stripped");
	assert.ok(!dump.includes("read already"), "read records are not dumped");

	if (prev !== undefined) (globalThis as Record<symbol, unknown>)[dumpSlot] = prev;
});

test("N-T8 fatal dump: repeat install registers exactly one listener; write failures swallowed", () => {
	const dumpSlot = Symbol.for("pi-claude-code-tui/notices-exit-dump");
	const prev = (globalThis as Record<symbol, unknown>)[dumpSlot];
	delete (globalThis as Record<symbol, unknown>)[dumpSlot];

	const center = makeCenter(100);
	center.setMode("quiet");
	center.intercept("error", "boom", 1);
	const registrations: number[] = [];
	let handler: ((code: number) => void) | undefined;
	const on = (fn: (code: number) => void): void => {
		registrations.push(1);
		handler = fn;
	};
	installFatalExitDump(() => center, () => {}, on);
	installFatalExitDump(() => center, () => {}, on);
	assert.equal(registrations.length, 1, "once per process");

	// A throwing write must not escape the exit callback.
	const boom = (): void => {
		throw new Error("pipe closed");
	};
	installFatalExitDump(() => { throw new Error("center gone"); }, boom, on); // still no second listener
	assert.equal(registrations.length, 1);
	handler!(1); // first handler, quiet write — must not throw
	assert.ok(true);

	if (prev !== undefined) (globalThis as Record<symbol, unknown>)[dumpSlot] = prev;
});

test("N-T6 tracker: local click override applies per-render and voids on global change (S6)", () => {
	const tracker = createNoticeExpansionTracker();
	const entry = { some: "entry" };
	assert.equal(tracker.effective(entry, false), false, "defaults to global");
	assert.equal(tracker.toggle(entry, false), true, "click expands");
	assert.equal(tracker.effective(entry, false), true, "override applies without a rebuild");
	assert.equal(tracker.toggle(entry, false), false, "second click collapses");
	assert.equal(tracker.effective(entry, false), false);
	// A local override recorded at global=false must void once the user
	// presses the global ctrl+o (atGlobal mismatch → global wins).
	tracker.toggle(entry, false); // local true at global false
	assert.equal(tracker.effective(entry, true), true, "global true wins over stale override");
	assert.equal(tracker.effective(entry, false), true, "still honored at its recorded state");
});
