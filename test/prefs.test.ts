/** Plan SL2: claude-tui.json read-modify-write store — writers must not wipe
 *  sibling keys, writes must be atomic, bad input must fall back to defaults. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPrefs, resolveStatusLinePrefs, savePrefs } from "../extensions/lib/prefs.ts";

const withTempFile = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "cctui-prefs-"));
	return join(dir, "claude-tui.json");
};

test("loadPrefs: absent file → {}", () => {
	const path = withTempFile();
	assert.deepEqual(loadPrefs(path), {});
});

test("loadPrefs: corrupt JSON → {} (never throws)", () => {
	const path = withTempFile();
	writeFileSync(path, "{ not json");
	assert.deepEqual(loadPrefs(path), {});
});

test("savePrefs merges instead of overwriting sibling keys", () => {
	const path = withTempFile();
	savePrefs({ toolRows: true }, path);
	savePrefs({ statusLine: { enabled: true } }, path);
	const onDisk = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(onDisk, { toolRows: true, statusLine: { enabled: true } });
});

test("savePrefs(undefined) clears its own key, keeps siblings (old toolRows semantics)", () => {
	const path = withTempFile();
	savePrefs({ toolRows: true, statusLine: { enabled: true, command: "my.sh" } }, path);
	savePrefs({ toolRows: undefined }, path);
	const onDisk = JSON.parse(readFileSync(path, "utf8"));
	assert.equal("toolRows" in onDisk, false);
	assert.deepEqual(onDisk.statusLine, { enabled: true, command: "my.sh" });
});

test("savePrefs creates parent directories", () => {
	const dir = mkdtempSync(join(tmpdir(), "cctui-prefs-"));
	const path = join(dir, "nested", "deep", "claude-tui.json");
	savePrefs({ toolRows: false }, path);
	assert.equal(loadPrefs(path).toolRows, false);
});

test("savePrefs leaves no .tmp file behind", () => {
	const path = withTempFile();
	savePrefs({ toolRows: true }, path);
	assert.equal(existsSync(`${path}.tmp`), false);
});

test("resolveStatusLinePrefs defaults and partial fills", () => {
	assert.deepEqual(resolveStatusLinePrefs(undefined), { enabled: false, command: "", badge: true });
	assert.deepEqual(resolveStatusLinePrefs({ enabled: true }), { enabled: true, command: "", badge: true });
	assert.deepEqual(resolveStatusLinePrefs({ enabled: true, command: "x", badge: false }), {
		enabled: true,
		command: "x",
		badge: false,
	});
	// Wrong-typed fields degrade to defaults instead of leaking through.
	assert.deepEqual(resolveStatusLinePrefs({ enabled: "yes" as unknown as boolean }), {
		enabled: false,
		command: "",
		badge: true,
	});
});

test("unknown keys on disk survive round-trips", () => {
	const path = withTempFile();
	writeFileSync(path, JSON.stringify({ futureKey: [1, 2], toolRows: true }));
	savePrefs({ statusLine: { enabled: false } }, path);
	const onDisk = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(onDisk.futureKey, [1, 2]);
	assert.equal(onDisk.toolRows, true);
});
