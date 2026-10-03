/** Effort-read seam: never throws, whatever the host does. */
import test from "node:test";
import assert from "node:assert/strict";

import { readEffortLevel } from "../extensions/lib/host-status.ts";

test("readEffortLevel: returns the level, tolerates a missing API and a throwing host", () => {
	assert.equal(readEffortLevel({ getThinkingLevel: () => "high" }), "high");
	assert.equal(readEffortLevel({}), undefined, "host without the API");
	assert.equal(readEffortLevel({ getThinkingLevel: () => undefined }), undefined, "host hides the level");
	assert.equal(
		readEffortLevel({
			getThinkingLevel() {
				throw new Error("stale host");
			},
		}),
		undefined,
		"throwing host must not propagate (render-stack safety)",
	);
});
