/** Plan SL3: statusline JSON synthesis, badge math, and the spawn runner. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
	appendBadge,
	buildStatuslineJson,
	composeFooterLines,
	splitStatuslineOutput,
	StatuslineRunner,
	type ChildLike,
	type SpawnFn,
} from "../extensions/lib/statusline.ts";
import { DEFAULT_STATUSLINE_SCRIPT } from "../extensions/lib/statusline-default-script.ts";
import type { UsageSnapshot } from "../extensions/lib/status-snapshot.ts";

const snap = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
	used: 26_400,
	cost: 0.0072,
	lastInput: 26_000,
	lastOutput: 400,
	totalInput: 28_000,
	totalOutput: 170,
	...over,
});

// ---------------------------------------------------------------------------
// buildStatuslineJson

test("buildStatuslineJson: schema matches the reference script's jq fields", () => {
	const json = JSON.parse(buildStatuslineJson(snap(), { displayName: "GLM 5.3", id: "glm-5.3", provider: "zai" }, 1_000_000, {
		cwd: "/Users/gd32/Coding/Pi-Extension",
		effort: "xhigh",
	}));
	assert.deepEqual(json, {
		model: { display_name: "GLM 5.3", id: "glm-5.3" },
		workspace: { current_dir: "/Users/gd32/Coding/Pi-Extension", project_dir: "/Users/gd32/Coding/Pi-Extension" },
		context_window: {
			context_window_size: 1_000_000,
			current_usage: { input_tokens: 26_000, output_tokens: 400 },
			total_input_tokens: 28_000,
			total_output_tokens: 170,
			used_percentage: 3,
			remaining_percentage: 97,
		},
		pi: { cost_usd: 0.0072, effort: "xhigh", provider: "zai" },
	});
});

test("buildStatuslineJson: zero window degrades to 0%/100%, not NaN", () => {
	const json = JSON.parse(buildStatuslineJson(snap(), { displayName: "", id: "" }, 0));
	assert.equal(json.context_window.context_window_size, 0);
	assert.equal(json.context_window.used_percentage, 0);
	assert.equal(json.context_window.remaining_percentage, 100);
	assert.deepEqual(json.pi, { cost_usd: 0.0072, effort: "", provider: "" });
});

test("buildStatuslineJson: percentage clamps at 100", () => {
	const json = JSON.parse(buildStatuslineJson(snap({ used: 1_500_000 }), { displayName: "m", id: "m" }, 1_000_000));
	assert.equal(json.context_window.used_percentage, 100);
	assert.equal(json.context_window.remaining_percentage, 0);
});

// ---------------------------------------------------------------------------
// appendBadge

test("appendBadge: right-aligns with at least a 2-column gap", () => {
	assert.equal(appendBadge("abc", "XY", 10), "abc     XY");
	assert.equal(appendBadge("abc", "XY", 7), "abc  XY"); // exact fit: 3+2+2
});

test("appendBadge: no room → null (script output never mangled)", () => {
	assert.equal(appendBadge("abc", "XY", 6), null); // 3+2+2 > 6
	assert.equal(appendBadge("abcdef", "XY", 9), null); // 6+2+2 > 9 (10 fits exactly)
	assert.equal(appendBadge("abc", "", 10), null);
	assert.equal(appendBadge("abc", "XY", 0), null);
});

test("appendBadge: ANSI escapes and CJK count as visual width", () => {
	const ansi = "\x1b[38;5;246mabc\x1b[39m";
	const out = appendBadge(ansi, "glm·xhigh", 20);
	assert.ok(out);
	assert.equal(out, `${ansi}${" ".repeat(8)}glm·xhigh`); // 3 visible + pad 8 + 9 visible = 20
});

// ---------------------------------------------------------------------------
// composeFooterLines — plan SL4/D2 four quadrants

const muted = (s: string) => `\x1b[38;5;246m${s}\x1b[39m`; // real ANSI so visibleWidth skips it
const HINTS = "⚡ bypass mode on · ! for bash mode";

test("composeFooterLines: statusline ON + hints (native-on) — script rows first, hints last", () => {
	assert.deepEqual(
		composeFooterLines({
			statuslineOn: true,
			badgeOn: false,
			lines: ["dir │ git │ model", "row2"],
			badgeText: "⊙ xhigh · /effort",
			badgePaint: muted,
			hints: HINTS,
			width: 80,
		}),
		["dir │ git │ model", "row2", HINTS],
	);
});

test("composeFooterLines: statusline ON, no hints (native-off) — script rows only", () => {
	assert.deepEqual(
		composeFooterLines({
			statuslineOn: true,
			badgeOn: false,
			lines: ["only-script"],
			badgeText: "",
			badgePaint: muted,
			hints: "",
			width: 80,
		}),
		["only-script"],
	);
});

test("composeFooterLines: statusline OFF — hints alone (= v1.4.5 widget)", () => {
	assert.deepEqual(
		composeFooterLines({
			statuslineOn: false,
			badgeOn: true,
			lines: ["ignored"],
			badgeText: "⊙ xhigh · /effort",
			badgePaint: muted,
			hints: HINTS,
			width: 80,
		}),
		[HINTS],
	);
});

test("composeFooterLines: badge right-aligned on first line; no room → line untouched", () => {
	const out = composeFooterLines({
		statuslineOn: true,
		badgeOn: true,
		lines: ["abc", "row2"],
		badgeText: "XY",
		badgePaint: muted,
		hints: "",
		width: 10,
	});
	assert.deepEqual(out, [`abc${" ".repeat(5)}\x1b[38;5;246mXY\x1b[39m`, "row2"]);

	const cramped = composeFooterLines({
		statuslineOn: true,
		badgeOn: true,
		lines: ["abcdef"],
		badgeText: "XY",
		badgePaint: muted,
		hints: "",
		width: 9,
	});
	assert.deepEqual(cramped, ["abcdef"]); // 6+2+2 > 9 → badge omitted
});

test("composeFooterLines: runner error line renders with hints; empty state keeps a row", () => {
	assert.deepEqual(
		composeFooterLines({
			statuslineOn: true,
			badgeOn: false,
			lines: ["<statusline> cmd failed (exit 1) — /claude-statusline off"],
			badgeText: "",
			badgePaint: muted,
			hints: HINTS,
			width: 80,
		}),
		["<statusline> cmd failed (exit 1) — /claude-statusline off", HINTS],
	);
	assert.deepEqual(
		composeFooterLines({ statuslineOn: true, badgeOn: false, lines: [], badgeText: "", badgePaint: muted, hints: "", width: 80 }),
		[""], // never zero rows: the dock keeps its line
	);
});

// ---------------------------------------------------------------------------
// splitStatuslineOutput

test("splitStatuslineOutput: CRLF-safe, drops trailing blanks, caps lines", () => {
	assert.deepEqual(splitStatuslineOutput("a\nb\n", 4), ["a", "b"]);
	assert.deepEqual(splitStatuslineOutput("a\r\nb\r\n\r\n", 4), ["a", "b"]);
	assert.deepEqual(splitStatuslineOutput("a\n\nb\n", 4), ["a", "", "b"]); // interior blank kept
	assert.deepEqual(splitStatuslineOutput("1\n2\n3\n4\n5\n6\n", 4), ["1", "2", "3", "4"]);
	assert.deepEqual(splitStatuslineOutput("", 4), []);
	assert.deepEqual(splitStatuslineOutput("\n\n", 4), []);
});

// ---------------------------------------------------------------------------
// StatuslineRunner (fake child processes)

interface FakeChild extends ChildLike {
	emitter: EventEmitter;
	stdoutEmitter: EventEmitter;
	stdinData: string;
	killed: boolean;
	spawnArgs: { command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } };
	exit(code: number | null): void;
	fail(err: Error): void;
	data(text: string): void;
}

const fakeSpawn = (): { spawnFn: SpawnFn; children: FakeChild[] } => {
	const children: FakeChild[] = [];
	const spawnFn: SpawnFn = (command, args, options) => {
		const emitter = new EventEmitter();
		const stdoutEmitter = new EventEmitter();
		const child: FakeChild = {
			emitter,
			stdoutEmitter,
			spawnArgs: { command, args, options },
			stdinData: "",
			killed: false,
			stdout: {
				on(event, listener) {
					stdoutEmitter.on(event, listener);
				},
			},
			stdin: {
				write(d: string) {
					child.stdinData += d;
				},
				end(d?: string) {
					if (d !== undefined) child.stdinData += d;
				},
			},
			on(event, listener) {
				emitter.on(event, listener as (...args: unknown[]) => void);
			},
			kill() {
				child.killed = true;
				emitter.emit("exit", null, "SIGKILL");
			},
			exit(code) {
				emitter.emit("exit", code, null);
			},
			fail(err) {
				emitter.emit("error", err);
			},
			data(text) {
				stdoutEmitter.emit("data", text);
			},
		};
		children.push(child);
		return child;
	};
	return { spawnFn, children };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const newRunner = (spawnFn: SpawnFn, over: Record<string, unknown> = {}) =>
	new StatuslineRunner({ command: "echo hi", debounceMs: 5, timeoutMs: 120, spawnFn, ...over });

test("runner: spawns bash -c with JSON on stdin and OVERRIDE_TERM_WIDTH", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn);
	runner.request('{"k":1}', 137);
	await sleep(30);
	assert.equal(children.length, 1);
	assert.deepEqual(children[0]!.spawnArgs.args, ["-c", "echo hi"]);
	assert.equal(children[0]!.stdinData, '{"k":1}');
	assert.equal(children[0]!.spawnArgs.options.env?.OVERRIDE_TERM_WIDTH, "137");
	runner.dispose();
});

test("runner: burst of requests coalesces into one spawn (latest input wins)", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn);
	runner.request('{"n":1}', 80);
	runner.request('{"n":2}', 80);
	runner.request('{"n":3}', 80);
	await sleep(30);
	assert.equal(children.length, 1);
	assert.equal(children[0]!.stdinData, '{"n":3}');
	runner.dispose();
});

test("runner: identical served state is a no-op", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn);
	runner.request('{"n":1}', 80);
	await sleep(30);
	children[0]!.data("hello\n");
	children[0]!.exit(0);
	await sleep(5);
	runner.request('{"n":1}', 80); // identical → no new spawn
	await sleep(30);
	assert.equal(children.length, 1);
	assert.deepEqual(runner.getRenderLines(), ["hello"]);
	runner.dispose();
});

test("runner: request mid-flight triggers exactly one follow-up run", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn);
	runner.request('{"n":1}', 80);
	await sleep(30); // spawn 1 in flight
	runner.request('{"n":2}', 80); // mid-flight
	runner.request('{"n":3}', 80); // still mid-flight, coalesced
	children[0]!.data("one\n");
	children[0]!.exit(0);
	await sleep(40); // follow-up spawns after debounce
	assert.equal(children.length, 2);
	assert.equal(children[1]!.stdinData, '{"n":3}');
	children[1]!.data("three\n");
	children[1]!.exit(0);
	await sleep(5);
	assert.deepEqual(runner.getRenderLines(), ["three"]);
	runner.dispose();
});

test("runner: failure keeps last-good; 3 consecutive failures surface the error line", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn);
	// Seed a good run.
	runner.request('{"n":1}', 80);
	await sleep(30);
	children[0]!.data("good\n");
	children[0]!.exit(0);
	await sleep(5);
	// Two failures: last-good survives, no error line yet.
	for (const n of [2, 3]) {
		runner.request(`{"n":${n}}`, 80);
		await sleep(30);
		children[children.length - 1]!.exit(1);
		await sleep(5);
	}
	assert.deepEqual(runner.getRenderLines(), ["good"]);
	assert.equal(runner.hasPersistentError(), false);
	// Third consecutive failure: dim error line replaces output.
	runner.request('{"n":4}', 80);
	await sleep(30);
	children[children.length - 1]!.exit(1);
	await sleep(5);
	assert.deepEqual(runner.getRenderLines(), ["<statusline> cmd failed (exit 1) — /claude-statusline off"]);
	assert.equal(runner.hasPersistentError(), true);
	// A success clears the error and restores output.
	runner.request('{"n":5}', 80);
	await sleep(30);
	children[children.length - 1]!.data("recovered\n");
	children[children.length - 1]!.exit(0);
	await sleep(5);
	assert.deepEqual(runner.getRenderLines(), ["recovered"]);
	assert.equal(runner.hasPersistentError(), false);
	runner.dispose();
});

test("runner: timeout kills the child and counts as a failure", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn, { timeoutMs: 30 });
	runner.request('{"n":1}', 80);
	await sleep(20); // child spawned, never exits on its own
	assert.equal(children.length, 1);
	await sleep(60); // timeout fires → kill → exit(SIGKILL) → settle("timeout")
	assert.deepEqual(runner.getRenderLines(), []); // failure 1: no error line yet
	assert.equal(runner.hasPersistentError(), false);
	runner.dispose();
});

test("runner: spawn 'error' event settles as a failure", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn);
	runner.request('{"n":1}', 80);
	await sleep(30);
	children[0]!.fail(new Error("ENOENT"));
	await sleep(5);
	assert.equal(runner.hasPersistentError(), false); // 1 failure only
	runner.dispose();
});

test("runner: line cap respected from real output", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn);
	runner.request('{"n":1}', 80);
	await sleep(30);
	children[0]!.data("1\n2\n3\n4\n5\n6\n7\n");
	children[0]!.exit(0);
	await sleep(5);
	assert.deepEqual(runner.getRenderLines(), ["1", "2", "3", "4"]);
	runner.dispose();
});

test("runner: onUpdate fires after each completed run", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn);
	let updates = 0;
	runner.setOnUpdate(() => updates++);
	runner.request('{"n":1}', 80);
	await sleep(30);
	children[0]!.exit(0);
	await sleep(5);
	assert.equal(updates, 1);
	runner.dispose();
});

test("runner: dispose kills in-flight child and silences updates", async () => {
	const { spawnFn, children } = fakeSpawn();
	const runner = newRunner(spawnFn);
	let updates = 0;
	runner.setOnUpdate(() => updates++);
	runner.request('{"n":1}', 80);
	await sleep(30);
	runner.dispose();
	assert.equal(children[0]!.killed, true);
	await sleep(20);
	assert.equal(updates, 0);
	runner.request('{"n":2}', 80); // disposed: no-op
	await sleep(30);
	assert.equal(children.length, 1);
});

// ---------------------------------------------------------------------------
// Bundled default script (plan SL5)

test("embedded default script stays byte-identical to scripts/statusline-default.sh", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../scripts/statusline-default.sh", import.meta.url), "utf8");
	// Strip exactly one trailing newline (the file's final line ending) —
	// anything else (extra blank lines) must fail as drift.
	assert.equal(DEFAULT_STATUSLINE_SCRIPT, source.replace(/\n$/, ""));
});

test("default script runs under `bash -c <source>` and renders the sample row", async () => {
	const { execFile } = await import("node:child_process");
	const sample = JSON.stringify({
		model: { display_name: "GLM 5.3", id: "zai/glm-5.3" },
		workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
		context_window: {
			context_window_size: 1_000_000,
			current_usage: { input_tokens: 26_000, output_tokens: 400 },
			total_input_tokens: 28_000,
			total_output_tokens: 170,
			used_percentage: 3,
			remaining_percentage: 97,
		},
		pi: { cost_usd: 0.0072, effort: "xhigh", provider: "zai" },
	});
	const out: string = await new Promise((resolve, reject) => {
		execFile("bash", ["-c", DEFAULT_STATUSLINE_SCRIPT], { env: { ...process.env, OVERRIDE_TERM_WIDTH: "140" } }, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout);
		}).stdin?.end(sample);
	});
	// Strip ANSI for the assertion; the Ctx percentages/tokens must match input.
	const plain = out.replace(/\x1b\[[0-9;]*m/g, "").trim();
	assert.match(plain, /Ctx 3% \(30k\/1M\)/);
	assert.match(plain, /GLM 5\.3/);
	assert.match(plain, /\$0\.0072/);
});
