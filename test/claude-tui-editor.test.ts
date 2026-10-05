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
