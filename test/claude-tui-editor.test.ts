/**
 * Editor blink-timer lifecycle tests (spec §8.1).
 *
 * The blink interval must be owned by the editor instance: released
 * idempotently before replacement and on disable/shutdown, unref'd so it
 * never holds the event loop, silent while unfocused, and permanently
 * parked after release. These tests patch the timer globals to observe
 * handle counts directly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CodexStyleEditor } from "../extensions/lib/claude-tui-editor.ts";

interface TrackedHandle {
	id: ReturnType<typeof setInterval>;
	unrefed: boolean;
}

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

function withTrackedTimers(run: (liveCount: () => number, handles: () => TrackedHandle[]) => void): void {
	const handles: TrackedHandle[] = [];
	globalThis.setInterval = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
		const handle = originalSetInterval(handler, ms, ...(rest as [])) as ReturnType<typeof setInterval>;
		const tracked: TrackedHandle = { id: handle, unrefed: false };
		const realUnref = (handle as unknown as { unref?: () => void }).unref?.bind(handle);
		(handle as unknown as { unref?: () => void }).unref = () => {
			tracked.unrefed = true;
			realUnref?.();
		};
		handles.push(tracked);
		return handle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
		const index = handles.findIndex((candidate) => candidate.id === id);
		if (index >= 0) handles.splice(index, 1);
		return originalClearInterval(id);
	}) as typeof clearInterval;
	try {
		run(() => handles.length, () => [...handles]);
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
}

function makeEditor(renderCount: { count: number }): CodexStyleEditor {
	const tui = {
		requestRender: () => { renderCount.count += 1; },
		terminal: { rows: 40, columns: 100 },
	};
	const theme = { borderColor: (border: string) => border, selectList: {} } as never;
	const keybindings = {} as never;
	return new CodexStyleEditor(tui as never, theme, keybindings, () => "\u001b[38;2;215;215;215m");
}

test("editor blink timer: at most one live timer, unref'd, released to zero", () => {
	withTrackedTimers((liveCount, handles) => {
		const renderCount = { count: 0 };
		const editor = makeEditor(renderCount);
		editor.render(80);
		editor.render(80);
		editor.render(80);
		assert.equal(liveCount(), 1, "repeated renders must not stack blink timers");
		assert.ok(handles()[0]?.unrefed, "the blink timer must be unref'd");

		editor.release();
		assert.equal(liveCount(), 0, "release clears the timer");

		// Renders after release must not resurrect the timer (a stale
		// instance can never touch an old TUI again).
		editor.render(80);
		assert.equal(liveCount(), 0);
	});
});

test("editor blink timer: 20 replace cycles leak nothing", () => {
	withTrackedTimers((liveCount) => {
		for (let cycle = 0; cycle < 20; cycle++) {
			const renderCount = { count: 0 };
			const editor = makeEditor(renderCount);
			editor.render(80);
			assert.equal(liveCount(), 1, `cycle ${cycle}: exactly one timer while live`);
			editor.release(); // what the entry does before replacing
		}
		assert.equal(liveCount(), 0, "20 enable/disable/reload cycles must end at zero timers");
	});
});

test("editor blink timer: release is idempotent", () => {
	withTrackedTimers((liveCount) => {
		const renderCount = { count: 0 };
		const editor = makeEditor(renderCount);
		editor.render(80);
		editor.release();
		editor.release();
		editor.release();
		assert.equal(liveCount(), 0);
	});
});

test("editor blink timer: ticks while unfocused never request renders", () => {
	withTrackedTimers((_liveCount, handles) => {
		const renderCount = { count: 0 };
		const editor = makeEditor(renderCount);
		editor.render(80);
		const handle = handles()[0];
		assert.ok(handle);
		// The editor starts unfocused in this harness (nothing focused it).
		// Advance the interval by firing the underlying native timer's
		// callback via a manual tick: emulate by waiting one real tick.
		const before = renderCount.count;
		return new Promise<void>((resolve) => {
			originalSetInterval(() => {
				assert.equal(renderCount.count, before, "unfocused ticks must not request renders");
				editor.release();
				resolve();
			}, 600).unref?.();
		});
	});
});

// ── restyleEditorCursor: dual wire forms (pi-tui 1.1 reverse / 1.2 fake) ──

import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { restyleEditorCursor } from "../extensions/lib/claude-tui-editor.ts";

const FAKE_START = "\x1b_pi:fc\x07";
const FAKE_END = "\x1b_pi:/fc\x07";
const BAR = "\x1b[48;2;1;2;3m▏\x1b[39m\x1b[49m"; // stand-in accent bar
const REVERSED = (ch: string) => `\x1b[7m${ch}\x1b[0m`;

test("cursor restyle 1.2: focused fake-cursor pair → accent bar; blink-off → plain char", () => {
	const line = `prompt ${CURSOR_MARKER}${FAKE_START}x${FAKE_END} tail`;
	assert.equal(restyleEditorCursor(line, BAR, true), `prompt ${CURSOR_MARKER}${BAR} tail`);
	assert.equal(restyleEditorCursor(line, BAR, false), `prompt ${CURSOR_MARKER}x tail`);
});

test("cursor restyle 1.2: END lost to truncation → cell runs to EOL (pi's own resolver pattern)", () => {
	const line = `prompt ${CURSOR_MARKER}${FAKE_START}x`;
	assert.equal(restyleEditorCursor(line, BAR, true), `prompt ${CURSOR_MARKER}${BAR}`);
	assert.equal(restyleEditorCursor(line, BAR, false), `prompt ${CURSOR_MARKER}x`);
});

test("cursor restyle 1.2: unfocused fake pair (no marker) is still restyled", () => {
	const line = `out ${FAKE_START}y${FAKE_END}`;
	assert.equal(restyleEditorCursor(line, BAR, true), `out ${BAR}`);
});

test("cursor restyle 1.1: reverse span after marker / unfocused first span (behavior unchanged)", () => {
	const focused = `prompt ${CURSOR_MARKER}${REVERSED("x")} tail`;
	assert.equal(restyleEditorCursor(focused, BAR, true), `prompt ${CURSOR_MARKER}${BAR} tail`);
	assert.equal(restyleEditorCursor(focused, BAR, false), `prompt ${CURSOR_MARKER}x tail`);
	assert.equal(restyleEditorCursor(`pre ${REVERSED("y")} tail`, BAR, true), `pre ${BAR} tail`);
});

test("cursor restyle: unfocused line without marker keeps the first-reverse-span semantics (1.1)", () => {
	// Documented pre-existing behavior: an unfocused editor's first short
	// reverse span IS the cursor and gets the bar.
	assert.equal(restyleEditorCursor(`text ${REVERSED("y")} more`, BAR, true), `text ${BAR} more`);
});
