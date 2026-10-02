import test from "node:test";
import assert from "node:assert/strict";
import { Theme } from "@earendil-works/pi-coding-agent";
import { ccCall, ccThenRunCall } from "../extensions/lib/cc-rows.ts";

// Use pi's actual class methods: arrow-function theme mocks hide lost receivers.
const theme = new Theme({
	dim: "", success: "", error: "", text: "", muted: "", thinkingXhigh: "",
} as ConstructorParameters<typeof Theme>[0], {
	selectedBg: "",
} as ConstructorParameters<typeof Theme>[1], "truecolor");

test("then_run renders with pi's receiver-dependent theme methods", () => {
	const call = ccCall(theme, "edit", "a.ts", "success", 0);
	const component = ccThenRunCall(theme, call, "echo ok");
	const expected = [...call.render(80), `  ${theme.fg("dim", "↳ then_run: echo ok")}`];
	assert.deepEqual(component.render(80), expected);
	component.invalidate();
	assert.deepEqual(component.render(80), expected);
});

test("absent, blank, or invalid then_run commands preserve the original call", () => {
	const call = ccCall(theme, "write", "a.ts", "success", 0);
	for (const command of [undefined, null, "", " \t", 42, {}]) {
		assert.equal(ccThenRunCall(theme, call, command), call);
	}
});
