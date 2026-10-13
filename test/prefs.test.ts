/** Plan SL2: claude-tui.json read-modify-write store — writers must not wipe
 *  sibling keys, writes must be atomic, bad input must fall back to defaults. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPrefs, resolveNoticeMode, resolveStatusLinePrefs, savePrefs } from "../extensions/lib/prefs.ts";

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

// ── N-T10 (spec 2026-10-13-cc-notices): notices.mode ──────────────────────

test("N-T10 resolveNoticeMode: quiet/off pass through; absent/illegal → compact", () => {
	assert.equal(resolveNoticeMode(undefined), "compact");
	assert.equal(resolveNoticeMode("compact"), "compact");
	assert.equal(resolveNoticeMode("quiet"), "quiet");
	assert.equal(resolveNoticeMode("off"), "off");
	// Illegal values (corrupt file, future modes) stay on the safe default.
	assert.equal(resolveNoticeMode("loud" as never), "compact");
	assert.equal(resolveNoticeMode(null as never), "compact");
});

test("N-T10 notices pref round-trips and keeps sibling keys", () => {
	const path = withTempFile();
	savePrefs({ toolRows: true }, path);
	savePrefs({ notices: { mode: "quiet" } }, path);
	const loaded = loadPrefs(path);
	assert.equal(loaded.toolRows, true, "sibling toolRows survived");
	assert.equal(loaded.notices?.mode, "quiet");
	assert.equal(resolveNoticeMode(loadPrefs(path).notices?.mode), "quiet");

	// A corrupt mode value resolves to compact without touching the file.
	writeFileSync(path, JSON.stringify({ notices: { mode: 42 }, toolRows: false }));
	assert.equal(resolveNoticeMode(loadPrefs(path).notices?.mode), "compact");
});
