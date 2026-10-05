/**
 * Subagent presentation bridge lifecycle tests (spec P3).
 *
 * Drives the bridge against a fake event bus and a faithful fake host
 * (mirroring upstream PresentationSeamHost semantics: version gate, reply
 * channels, generation-guarded handles) to pin: registration on session
 * start, late-host re-registration (load order), withdraw on stop, session
 * races, diagnostics forwarding, and no-timer behavior on missing hosts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	SUBAGENT_PRESENTATION_DIAGNOSTIC_EVENT,
	SUBAGENT_PRESENTATION_READY_EVENT,
	SubagentPresentationBridge,
	type SubagentPresentationDiagnosticPayload,
	type SubagentPresentationDraw,
	type SubagentPresentationDrawResult,
	type SubagentPresentationEventBus,
	type SubagentPresentationFleetFrame,
	type SubagentPresentationFrame,
	type SubagentPresentationReadyPayload,
	type SubagentPresentationRegistrationHandle,
} from "../extensions/lib/subagent-presentation.ts";

class FakeBus implements SubagentPresentationEventBus {
	readonly emitted: Array<{ channel: string; data: unknown }> = [];
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(channel) ?? [];
		list.push(handler);
		this.handlers.set(channel, list);
		return () => {
			const current = this.handlers.get(channel) ?? [];
			this.handlers.set(channel, current.filter((candidate) => candidate !== handler));
		};
	}

	emit(channel: string, data: unknown): void {
		this.emitted.push({ channel, data });
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}
}

interface FakeHostOptions {
	bus: FakeBus;
	session?: string | null;
	generation?: number;
	surfaces?: string[];
}

type SubagentSurfaceName = "fleet" | "async";

/** Mirrors upstream PresentationSeamHost registration semantics. */
class FakeHost {
	private active = false;
	private session: string | null;
	private readonly generation: number;
	private readonly surfaces: SubagentSurfaceName[];
	private registered: { token: string; identity: string; surfaces: string[]; disposed: boolean } | undefined;
	readonly registeredAdapters: Array<{ identity: string; surfaces: string[] }> = [];
	readonly withdrawn: string[] = [];
	private readonly options: FakeHostOptions;
	/** When set, the next register round replies this status instead. */
	failNextRegistration: "not-ready" | "conflict" | undefined;

	constructor(options: FakeHostOptions) {
		options.bus.on("pi-subagents:presentation:v1:probe", (raw) => {
			if ((raw as { protocol?: number })?.protocol === 1) this.publishReady();
		});
		this.options = options;
		this.session = options.session ?? "session-1";
		this.generation = options.generation ?? 0;
		this.surfaces = (options.surfaces ?? ["fleet"]) as SubagentSurfaceName[];
		options.bus.on("pi-subagents:presentation:v1:register", (raw) => {
			const envelope = raw as { protocol: number; replyChannel: string; request: { identity: string; session?: string | null; runtimeGeneration?: number; surfaces: Record<string, unknown> } };
			const reply = (payload: unknown): void => options.bus.emit(envelope.replyChannel, payload);
			if (envelope.protocol !== 1) return reply({ status: "incompatible", reason: "protocol 1 required" });
			if (!this.active) return reply({ status: "not-ready", reason: "host not active" });
			if (this.failNextRegistration) {
				const failure = this.failNextRegistration;
				this.failNextRegistration = undefined;
				return reply({ status: failure, reason: "injected failure" });
			}
			if (envelope.request.session !== undefined && envelope.request.session !== null && envelope.request.session !== this.session) {
				return reply({ status: "not-ready", reason: "different session" });
			}
			const surfaces = Object.keys(envelope.request.surfaces).filter((surface) => this.surfaces.includes(surface as SubagentSurfaceName));
			if (!surfaces.length) return reply({ status: "incompatible", reason: "no supported surface" });
			if (this.registered?.identity !== envelope.request.identity && this.registered && !this.registered.disposed) {
				return reply({ status: "conflict", reason: `owned by ${this.registered.identity}` });
			}
			const previous = this.registered;
			const token = `tok:${envelope.request.identity}:${this.registeredAdapters.length}`;
			const record = { token, identity: envelope.request.identity, surfaces, disposed: false };
			this.registered = record;
			this.registeredAdapters.push({ identity: record.identity, surfaces });
			const handle: SubagentPresentationRegistrationHandle = {
				token,
				identity: record.identity,
				generation: this.generation,
				surfaces: surfaces as SubagentSurfaceName[],
				dispose: () => {
					if (record.disposed) return;
					record.disposed = true;
					this.withdrawn.push(token);
					if (this.registered === record) this.registered = undefined;
				},
			};
			reply({ status: previous && !previous.disposed ? "replaced" : "activated", handle, surfaces });
		});
	}

	activate(): void {
		this.active = true;
	}

	publishReady(): void {
		if (!this.active) return;
		const payload: SubagentPresentationReadyPayload = {
			protocol: 1,
			surfaces: this.surfaces as SubagentPresentationReadyPayload["surfaces"],
			session: this.session,
			runtimeGeneration: this.generation,
			events: {
				ready: SUBAGENT_PRESENTATION_READY_EVENT,
				register: "pi-subagents:presentation:v1:register",
				withdraw: "pi-subagents:presentation:v1:withdraw",
				diagnostic: SUBAGENT_PRESENTATION_DIAGNOSTIC_EVENT,
			},
		};
		this.options.bus.emit(SUBAGENT_PRESENTATION_READY_EVENT, payload);
	}
}

const drawNoop: SubagentPresentationDraw = (frame: SubagentPresentationFrame): SubagentPresentationDrawResult => ({
	lines: frame.rows.map(() => "cc"),
	layout: frame.rows.map((row: { rowKey: string }, index: number) => ({ rowKey: row.rowKey, fromLine: index, toLine: index, truncated: false })),
});

void (undefined as unknown as SubagentPresentationFleetFrame);

test("bridge: registers on start when the host is already ready (load order A)", async () => {
	const bus = new FakeBus();
	const host = new FakeHost({ bus });
	host.activate();
	host.publishReady();
	const statuses: string[] = [];
	const bridge = new SubagentPresentationBridge({ events: bus, surfaces: { fleet: drawNoop }, onStatusChange: (status) => statuses.push(status), handshakeTimeoutMs: 50 });
	bridge.start("session-1");
	await settle();
	assert.equal(bridge.status(), "active");
	assert.deepEqual(host.registeredAdapters, [{ identity: "cc-tui", surfaces: ["fleet"] }]);
	bridge.stop();
	assert.equal(bridge.status(), "off");
	assert.deepEqual(host.withdrawn, ["tok:cc-tui:0"]);
});

test("bridge: registers when the host becomes ready later (load order B)", async () => {
	const bus = new FakeBus();
	const host = new FakeHost({ bus });
	const bridge = new SubagentPresentationBridge({ events: bus, surfaces: { fleet: drawNoop }, handshakeTimeoutMs: 20 });
	bridge.start("session-1");
	await settle(30);
	assert.equal(bridge.status(), "no-host", "no host answered the bounded probe");
	host.activate();
	host.publishReady();
	await settle();
	assert.equal(bridge.status(), "active");
	assert.deepEqual(host.registeredAdapters, [{ identity: "cc-tui", surfaces: ["fleet"] }]);
	bridge.dispose();
});

test("bridge: session race settles back to registering and recovers on the next ready", async () => {
	const bus = new FakeBus();
	const host = new FakeHost({ bus, session: "session-1" });
	host.activate();
	host.publishReady();
	const bridge = new SubagentPresentationBridge({ events: bus, surfaces: { fleet: drawNoop }, handshakeTimeoutMs: 50 });
	host.failNextRegistration = "not-ready";
	// The race path: the host rejects one round; the overlapping probe/ready
	// registration recovers through the real reply channel without timers.
	bridge.start("session-1");
	await settle();
	assert.ok(bridge.status() === "active" || bridge.status() === "registering", `midpoint status: ${bridge.status()}`);
	host.publishReady();
	await settle();
	assert.equal(bridge.status(), "active");
	bridge.stop();
});

test("bridge: unsupported when the host offers no matching surface", async () => {
	const bus = new FakeBus();
	const host = new FakeHost({ bus, surfaces: ["async"] });
	host.activate();
	host.publishReady();
	const bridge = new SubagentPresentationBridge({ events: bus, surfaces: { fleet: drawNoop }, handshakeTimeoutMs: 50 });
	bridge.start("session-1");
	await settle();
	assert.equal(bridge.status(), "unsupported");
	assert.deepEqual(host.registeredAdapters, []);
	bridge.dispose();
});

test("bridge: foreign protocol versions report unsupported and never register", async () => {
	const bus = new FakeBus();
	bus.on(SUBAGENT_PRESENTATION_READY_EVENT, () => undefined);
	const bridge = new SubagentPresentationBridge({ events: bus, surfaces: { fleet: drawNoop }, handshakeTimeoutMs: 30 });
	bridge.start("session-1");
	await settle(40);
	assert.equal(bridge.status(), "no-host");
	// A v9 host broadcasting later must not be adopted.
	bus.emit(SUBAGENT_PRESENTATION_READY_EVENT, { protocol: 9, surfaces: ["fleet"] });
	await settle();
	assert.equal(bridge.status(), "unsupported");
	assert.equal(bus.emitted.filter(({ channel }) => channel === "pi-subagents:presentation:v1:register").length, 0);
	bridge.dispose();
});

test("bridge: forwards upstream draw-failure diagnostics", async () => {
	const bus = new FakeBus();
	const host = new FakeHost({ bus });
	host.activate();
	host.publishReady();
	const diagnostics: SubagentPresentationDiagnosticPayload[] = [];
	const bridge = new SubagentPresentationBridge({ events: bus, surfaces: { fleet: drawNoop }, onDiagnostic: (payload) => diagnostics.push(payload), handshakeTimeoutMs: 50 });
	bridge.start("session-1");
	await settle();
	bus.emit(SUBAGENT_PRESENTATION_DIAGNOSTIC_EVENT, { protocol: 1, identity: "cc-tui", surface: "fleet", reason: "boom", occurrence: 1 });
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0]?.reason, "boom");
	bridge.dispose();
});

test("bridge: stop before activation is a no-op; double stop stays clean", async () => {
	const bus = new FakeBus();
	const bridge = new SubagentPresentationBridge({ events: bus, surfaces: { fleet: drawNoop }, handshakeTimeoutMs: 10 });
	bridge.stop();
	bridge.stop();
	assert.equal(bridge.status(), "off");
	bridge.dispose();
	bridge.dispose();
});

function settle(ms = 5): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
