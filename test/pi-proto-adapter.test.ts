/**
 * Prototype-method adapter lifecycle tests (spec 8.3).
 *
 * Pins the centralized rules for the pi-owned prototype patches
 * (compaction row, skill row, user bar): getter refresh on repeated
 * installs, ownership-guarded restore, shape-mismatch and exception
 * degradation to the saved original, and marker-based hand-off between
 * adapter instances (the reload shape).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PrototypeMethodAdapter, type ThemeFg } from "../extensions/lib/pi-proto-adapter.ts";

interface TestHost {
	value: string;
	ran: string;
	updateDisplay(): void;
}

function makeClass(): new () => TestHost {
	return class {
		value = "original";
		ran = "";
		updateDisplay(): void {
			this.ran = "original";
		}
	};
}

const plain: ThemeFg = (_color, text) => text;

test("adapter: apply replaces the method; restore withdraws it", () => {
	const cls = makeClass();
	const adapter = new PrototypeMethodAdapter({
		proto: cls.prototype,
		method: "updateDisplay",
		marker: "__ccTest",
		hostMatches: (host) => typeof (host as TestHost)?.value === "string",
		body: (host) => {
			(host as unknown as TestHost).ran = "cc";
		},
	});
	adapter.apply(() => plain);
	const host = new cls();
	host.updateDisplay();
	assert.equal(host.ran, "cc");
	adapter.restore();
	host.updateDisplay();
	assert.equal(host.ran, "original");
});

test("adapter: repeated apply refreshes the live getter — marker never freezes a closure (spec 8.3 core bug)", () => {
	const cls = makeClass();
	const adapter = new PrototypeMethodAdapter({
		proto: cls.prototype,
		method: "updateDisplay",
		marker: "__ccTest",
		hostMatches: () => true,
		body: (host, fg) => {
			(host as unknown as TestHost).ran = fg("x", "cc");
		},
	});
	const callsA: string[] = [];
	const getterA = (): ThemeFg => (_c, text) => {
		callsA.push(text);
		return `A:${text}`;
	};
	adapter.apply(getterA);
	const host = new cls();
	host.updateDisplay();
	assert.equal(host.ran, "A:cc");

	// Re-enable with a new getter: the marker must NOT short-circuit this.
	const getterB = (): ThemeFg => (_c, text) => `B:${text}`;
	adapter.apply(getterB);
	host.updateDisplay();
	assert.equal(host.ran, "B:cc");
	adapter.restore();
});

test("adapter: a second instance (reload shape) refreshes the first instance's getter via the marker", () => {
	const cls = makeClass();
	const first = new PrototypeMethodAdapter({
		proto: cls.prototype,
		method: "updateDisplay",
		marker: "__ccTest",
		hostMatches: () => true,
		body: (host, fg) => {
			(host as unknown as TestHost).ran = fg("x", "cc");
		},
	});
	first.apply(() => (_c, text) => `A:${text}`);
	// A "reloaded" module creates a fresh adapter for the same proto/marker.
	const second = new PrototypeMethodAdapter({
		proto: cls.prototype,
		method: "updateDisplay",
		marker: "__ccTest",
		hostMatches: () => true,
		body: (host, fg) => {
			(host as unknown as TestHost).ran = fg("x", "cc");
		},
	});
	second.apply(() => (_c, text) => `B:${text}`);
	const host = new cls();
	host.updateDisplay();
	assert.equal(host.ran, "B:cc", "the marker hand-off must refresh the owning closure");
	// The second instance does not own the method: its restore is a no-op
	// and must not strip the first instance's rewrite.
	second.restore();
	host.updateDisplay();
	assert.equal(host.ran, "B:cc");
	first.restore();
	host.updateDisplay();
	assert.equal(host.ran, "original");
});

test("adapter: host shape mismatch degrades to the saved original", () => {
	const cls = makeClass();
	const adapter = new PrototypeMethodAdapter({
		proto: cls.prototype,
		method: "updateDisplay",
		marker: "__ccTest",
		hostMatches: (host) => typeof (host as { required?: unknown })?.required === "function",
		body: () => {
			throw new Error("must not run");
		},
	});
	adapter.apply(() => plain);
	const host = new cls(); // no .required
	host.updateDisplay();
	assert.equal(host.ran, "original");
	adapter.restore();
});

test("adapter: body exceptions never escape — the original renders instead", () => {
	const cls = makeClass();
	const adapter = new PrototypeMethodAdapter({
		proto: cls.prototype,
		method: "updateDisplay",
		marker: "__ccTest",
		hostMatches: () => true,
		body: () => {
			throw new Error("render blew up");
		},
	});
	adapter.apply(() => plain);
	const host = new cls();
	assert.doesNotThrow(() => host.updateDisplay());
	assert.equal(host.ran, "original");
	adapter.restore();
});

test("adapter: restore after another extension took over leaves the taker in place", () => {
	const cls = makeClass();
	const adapter = new PrototypeMethodAdapter({
		proto: cls.prototype,
		method: "updateDisplay",
		marker: "__ccTest",
		hostMatches: () => true,
		body: (host) => {
			(host as unknown as TestHost).ran = "cc";
		},
	});
	adapter.apply(() => plain);
	// A third party replaces the method after us.
	(cls.prototype as unknown as Record<string, unknown>).updateDisplay = function (this: TestHost) {
		this.ran = "third-party";
	};
	adapter.restore();
	const host = new cls();
	host.updateDisplay();
	assert.equal(host.ran, "third-party", "restore must not clobber a later owner");
});

test("adapter: null getter renders unstyled text, never throws", () => {
	const cls = makeClass();
	const adapter = new PrototypeMethodAdapter({
		proto: cls.prototype,
		method: "updateDisplay",
		marker: "__ccTest",
		hostMatches: () => true,
		body: (host, fg) => {
			(host as unknown as TestHost).ran = fg("dim", "cc");
		},
	});
	adapter.apply(() => null);
	const host = new cls();
	host.updateDisplay();
	assert.equal(host.ran, "cc");
	adapter.restore();
});

test("adapter: off → on cycle reinstalls cleanly after restore", () => {
	const cls = makeClass();
	const adapter = new PrototypeMethodAdapter({
		proto: cls.prototype,
		method: "updateDisplay",
		marker: "__ccTest",
		hostMatches: () => true,
		body: (host) => {
			(host as unknown as TestHost).ran = "cc";
		},
	});
	for (let cycle = 0; cycle < 3; cycle++) {
		adapter.apply(() => plain);
		const host = new cls();
		host.updateDisplay();
		assert.equal(host.ran, "cc");
		adapter.restore();
		host.updateDisplay();
		assert.equal(host.ran, "original");
	}
});
