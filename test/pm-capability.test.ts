/** B7 channel tests: priority chain, version gating, legacy fallbacks. */
import test from "node:test";
import assert from "node:assert/strict";

import {
	PM_MODE_ENV,
	publishCcTuiCapability,
	readPmStatus,
	withdrawCcTuiCapability,
} from "../extensions/lib/pm-capability.ts";

const cap = (over: Record<string, unknown> = {}) => ({
	version: 1,
	active: true,
	mode: "auto",
	workingStats: "↑1.2k · ↓300",
	...over,
});

test("versioned capability wins; workingStats used verbatim", () => {
	const store: Record<string, unknown> = {
		__piPermissionModes: cap(),
		__pmWorkingStats: "(legacy)",
	};
	assert.deepEqual(readPmStatus(store), { workingStats: "↑1.2k · ↓300", mode: "auto" });
});

test("capability with empty stats falls back to legacy key (paren-stripped)", () => {
	const store: Record<string, unknown> = {
		__piPermissionModes: cap({ workingStats: null }),
		__pmWorkingStats: "(↑9 · ↓9)",
	};
	assert.deepEqual(readPmStatus(store), { workingStats: "↑9 · ↓9", mode: "auto" });
});

test("unversioned capability is ignored — pure legacy path", () => {
	process.env[PM_MODE_ENV] = "plan";
	try {
		const store: Record<string, unknown> = {
			__piPermissionModes: { active: true }, // no version
			__pmWorkingStats: "(↑1)",
		};
		assert.deepEqual(readPmStatus(store), { workingStats: "↑1", mode: "plan" });
	} finally {
		delete process.env[PM_MODE_ENV];
	}
});

test("no channel at all yields empty status", () => {
	assert.deepEqual(readPmStatus({}), { workingStats: "", mode: "" });
});

test("cc-tui presence publish/withdraw keeps both keys in sync", () => {
	const store: Record<string, unknown> = {};
	publishCcTuiCapability(store);
	assert.equal((store.__piCcTui as { active: boolean }).active, true);
	assert.equal(store.__ccTuiActive, true);
	withdrawCcTuiCapability(store);
	assert.equal(store.__piCcTui, undefined);
	assert.equal(store.__ccTuiActive, undefined);
});
