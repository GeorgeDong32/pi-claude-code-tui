import assert from "node:assert/strict";
import test from "node:test";

import { createObsAdapter, readObsSites, type ObsSavingsSite } from "../extensions/lib/obs-savings.ts";
import { createCoreBusClient, type CoreBusAdapter } from "../extensions/lib/core-bus.ts";

/**
 * OBS-09-SITES adapter (P0-2/B5): on each genuinely-new first-replacement
 * publish, hand the FRESH sites to the callback (the entry appends a
 * display-only session entry). The observation channel persists the latest
 * batch in the snapshot between publishes, so re-delivered (old) sites must
 * not re-fire — dedupe is the full tuple (tool/id/toolCallId/avoidedTokens)
 * over the CURRENT session domain. Absent channel → silent. Callback throws
 * are swallowed and the batch is marked attempted.
 */

function site(id: string, tokens: number, tool = "bash", toolCallId?: string): ObsSavingsSite {
	return toolCallId === undefined ? { tool, id, avoidedTokens: tokens } : { tool, id, avoidedTokens: tokens, toolCallId };
}

interface TestBus {
	store: Record<string, unknown>;
	listeners: Array<() => void>;
	publish(patch: Record<string, unknown>): void;
}

const newBus = (initial: Record<string, unknown> = {}): TestBus => {
	const listeners: Array<() => void> = [];
	const store: Record<string, unknown> = {
		__piClaudeCodeCore: {
			version: 2,
			onChange: (fn: () => void) => {
				listeners.push(fn);
				return () => {
					const idx = listeners.indexOf(fn);
					if (idx >= 0) listeners.splice(idx, 1);
				};
			},
			...initial,
		},
	};
	return {
		store,
		listeners,
		publish(patch) {
			const snapshot = store.__piClaudeCodeCore as Record<string, unknown>;
			Object.assign(snapshot, patch);
			for (const listener of [...listeners]) listener();
		},
	};
};

const wireObs = (
	store: Record<string, unknown>,
	onSites: (sites: ObsSavingsSite[]) => void,
	adapters: CoreBusAdapter[] = [],
) => {
	const obs = createObsAdapter(onSites);
	const client = createCoreBusClient({ store, adapters: [...adapters, obs.adapter] });
	return { obs, client };
};

test("adapter: new sites fire the callback once; persisted-channel re-delivery is deduped", () => {
	const calls: ObsSavingsSite[][] = [];
	const bus = newBus();
	const { client } = wireObs(bus.store, (sites) => calls.push(sites));
	client.activate();
	assert.deepEqual(calls, [], "baseline (declaration-time) sites are history");
	bus.publish({ observation: { sites: [site("obs_a", 100)] } });
	assert.deepEqual(calls, [[site("obs_a", 100)]]);
	bus.publish({}); // unrelated publish re-delivers the persisted array
	assert.deepEqual(calls, [[site("obs_a", 100)]]);
	bus.publish({ observation: { sites: [site("obs_a", 100), site("obs_b", 50, "read")] } });
	assert.deepEqual(calls.at(-1), [site("obs_b", 50, "read")], "only the fresh site of the new batch fires");
	client.close();
});

test("adapter (B5): stop→start does not re-deliver the persisted sites; tuple key includes toolCallId", () => {
	const calls: ObsSavingsSite[][] = [];
	const bus = newBus({ observation: { sites: [site("obs_a", 100, "bash", "call_1")] } });
	const { client } = wireObs(bus.store, (sites) => calls.push(sites));
	// First session: the declaration-time batch is history; a NEW batch shows.
	client.activate();
	bus.publish({ observation: { sites: [site("obs_a", 100, "bash", "call_1"), site("obs_b", 5, "read", "call_2")] } });
	assert.equal(calls.length, 1);
	client.close(); // /claude-tui off — off-period batches are not back-filled
	bus.publish({ observation: { sites: [site("obs_c", 7, "read", "call_3")] } });
	assert.equal(calls.length, 1, "off: nothing delivered");
	// on → the snapshot at re-declaration becomes the new history baseline.
	client.activate();
	bus.publish({}); // persisted channel re-delivered
	assert.equal(calls.length, 1, "re-activation does not replay history");
	// Same id but a different toolCallId is a distinct site (B5).
	bus.publish({ observation: { sites: [site("obs_c", 7, "read", "call_4")] } });
	assert.deepEqual(calls.at(-1), [site("obs_c", 7, "read", "call_4")]);
	client.close();
});

test("adapter: callback exceptions are swallowed; the failed batch is marked attempted", () => {
	const calls: ObsSavingsSite[][] = [];
	const bus = newBus();
	const { client } = wireObs(bus.store, (sites) => {
		calls.push(sites);
		throw new Error("boom");
	});
	client.activate();
	bus.publish({ observation: { sites: [site("obs_a", 1)] } }); // throws inside — swallowed
	bus.publish({}); // same persisted array — NOT retried (attempted once)
	bus.publish({ observation: { sites: [site("obs_b", 2)] } }); // a different batch works
	assert.deepEqual(calls, [[site("obs_a", 1)], [site("obs_b", 2)]]);
	client.close();
});

test("adapter (C10): resetSeenFromBranch rebuilds the dedupe set from persisted entries", () => {
	const calls: ObsSavingsSite[][] = [];
	const bus = newBus();
	const { obs, client } = wireObs(bus.store, (sites) => calls.push(sites));
	// A reloaded session whose branch already carries packed entries.
	const branch = [
		{ type: "custom", customType: "cc-tui/observation-packed", data: { sites: [site("obs_a", 100, "bash", "call_1")] } },
		{ type: "message" },
		{ type: "custom", customType: "cc-tui/observation-packed", data: { sites: "junk" } },
	];
	obs.resetSeenFromBranch(branch);
	client.activate();
	// The bus re-publishes the same persisted sites after resume — deduped.
	bus.publish({ observation: { sites: [site("obs_a", 100, "bash", "call_1")] } });
	assert.deepEqual(calls, []);
	// A genuinely new site still delivers.
	bus.publish({ observation: { sites: [site("obs_a", 100, "bash", "call_1"), site("obs_z", 9)] } });
	assert.deepEqual(calls.at(-1), [site("obs_z", 9)]);
	client.close();
});

test("adapter: no onChange (old core / not loaded) stays silent", () => {
	const calls: ObsSavingsSite[][] = [];
	const store: Record<string, unknown> = {};
	const local = createCoreBusClient({ store, adapters: [createObsAdapter((s) => calls.push(s)).adapter] });
	local.activate();
	assert.deepEqual(calls, []);
	local.close();
});

test("readObsSites: malformed channel entries are skipped, never throw", () => {
	assert.deepEqual(
		readObsSites({
			__piClaudeCodeCore: {
				observation: {
					sites: ["junk", null, { tool: 1 }, site("obs_a", 1), { tool: "read", id: "obs_b", avoidedTokens: 2, toolCallId: "call_x" }],
				},
			},
		}),
		[site("obs_a", 1), { tool: "read", id: "obs_b", avoidedTokens: 2, toolCallId: "call_x" }],
	);
	assert.deepEqual(readObsSites({}), []);
	assert.deepEqual(readObsSites({ __piClaudeCodeCore: { observation: {} } }), []);
});
