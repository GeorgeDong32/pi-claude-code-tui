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

// ---------------------------------------------------------------------------
// P0-1 TUI-06 (spec E5/E7/E8): deterministic scheduler + bounded child
// termination. Time is stepped manually — no sleeps racing timers.

import type { RunnerScheduler } from "../extensions/lib/statusline.ts";

interface FakeTimer {
	fn: () => void;
	at: number;
	unrefd: boolean;
	cancelled: boolean;
	handle: { unref(): void };
}

const fakeClock = () => {
	const timers: FakeTimer[] = [];
	let now = 0;
	const scheduler: RunnerScheduler = {
		setTimeout(fn, ms) {
			const timer: FakeTimer = { fn, at: now + ms, unrefd: false, cancelled: false, handle: undefined as unknown as FakeTimer["handle"] };
			timer.handle = { unref: () => { timer.unrefd = true; } };
			timers.push(timer);
			return timer.handle;
		},
		clearTimeout(handle) {
			const timer = timers.find((t) => t.handle === handle);
			if (timer) timer.cancelled = true;
		},
	};
	return {
		scheduler,
		/** Advance the clock, firing due timers in deadline order. */
		advance(ms: number): void {
			const target = now + ms;
			for (;;) {
				const due = timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				now = due.at;
				due.cancelled = true; // fired
				due.fn();
			}
			now = target;
		},
		/** Every timer that was actually created got unref()'d (AGENTS trap 11). */
		allUnrefed(): boolean {
			return timers.every((t) => t.unrefd);
		},
	};
};

/** A child that records kill signals and does NOT exit (ignores TERM/KILL). */
interface StubbornChild extends ChildLike {
	signals: string[];
	exit(code: number | null): void;
	fail(err: Error): void;
	data(text: string): void;
}

const stubbornSpawn = (): { spawnFn: SpawnFn; children: StubbornChild[] } => {
	const children: StubbornChild[] = [];
	const spawnFn: SpawnFn = (command, args, options) => {
		const child = fakeSpawnChild();
		child.kill = (signal?: string) => {
			child.signals.push(signal ?? "SIGTERM");
			// deliberately does NOT emit exit — ignores every signal
		};
		children.push(child);
		void command; void args; void options;
		return child;
	};
	return { spawnFn, children };
};

// Reuse the fakeSpawn child shape but without auto-exit on kill.
const fakeSpawnChild = (): StubbornChild => {
	const emitter = new EventEmitter();
	const stdoutEmitter = new EventEmitter();
	const child: StubbornChild = {
		signals: [],
		stdout: { on(event, listener) { stdoutEmitter.on(event, listener); } },
		stdin: { write() {}, end() {} },
		on(event, listener) { emitter.on(event, listener as (...args: unknown[]) => void); },
		kill() {},
		exit(code) { emitter.emit("exit", code, null); },
		fail(err) { emitter.emit("error", err); },
		data(text) { stdoutEmitter.emit("data", text); },
	};
	return child;
};

test("E7: dispose sends TERM then KILL at +750ms to a stubborn child", () => {
	const { spawnFn, children } = stubbornSpawn();
	const clock = fakeClock();
	const runner = new StatuslineRunner({ command: "x", debounceMs: 5, timeoutMs: 10_000, spawnFn, scheduler: clock.scheduler });
	runner.request("{}", 80);
	clock.advance(5); // debounce → launch
	assert.equal(children.length, 1);
	runner.dispose();
	assert.deepEqual(children[0]!.signals, ["SIGTERM"]);
	clock.advance(749);
	assert.deepEqual(children[0]!.signals, ["SIGTERM"], "no KILL before the deadline");
	clock.advance(1);
	assert.deepEqual(children[0]!.signals, ["SIGTERM", "SIGKILL"]);
	assert.ok(clock.allUnrefed(), "dispose escalation timer is unref'd");
});

test("E7: repeated dispose neither cancels nor postpones the escalation", () => {
	const { spawnFn, children } = stubbornSpawn();
	const clock = fakeClock();
	const runner = new StatuslineRunner({ command: "x", debounceMs: 5, timeoutMs: 10_000, spawnFn, scheduler: clock.scheduler });
	runner.request("{}", 80);
	clock.advance(5);
	runner.dispose();
	runner.dispose();
	runner.dispose();
	clock.advance(750);
	assert.deepEqual(children[0]!.signals, ["SIGTERM", "SIGKILL"], "exactly one KILL at the original deadline");
});

test("E7: dispose after the timeout already sent TERM keeps the ORIGINAL escalation deadline", () => {
	const { spawnFn, children } = stubbornSpawn();
	const clock = fakeClock();
	const runner = new StatuslineRunner({ command: "x", debounceMs: 5, timeoutMs: 30, spawnFn, scheduler: clock.scheduler });
	runner.request("{}", 80);
	clock.advance(5); // launch at t=5
	clock.advance(30); // timeout at t=35: TERM + escalation scheduled for t=785
	assert.deepEqual(children[0]!.signals, ["SIGTERM"]);
	runner.dispose(); // t=35 — must NOT move the deadline to t=785+ (i.e. 36+750=786 shape)
	clock.advance(749); // t=784
	assert.deepEqual(children[0]!.signals, ["SIGTERM"], "still no KILL just before the original deadline");
	clock.advance(1); // t=785
	assert.deepEqual(children[0]!.signals, ["SIGTERM", "SIGKILL"]);
});

test("E8: a child that exits cleans its timers — no kill, no late escalation", () => {
	const { spawnFn, children } = stubbornSpawn();
	const clock = fakeClock();
	const runner = new StatuslineRunner({ command: "x", debounceMs: 5, timeoutMs: 30, spawnFn, scheduler: clock.scheduler });
	runner.request("{}", 80);
	clock.advance(5);
	children[0]!.data("hi\n");
	children[0]!.exit(0);
	clock.advance(10_000);
	assert.deepEqual(children[0]!.signals, [], "an exited child is never killed");
	assert.deepEqual(runner.getRenderLines(), ["hi"]);
	assert.ok(clock.allUnrefed());
});

test("E8: kill() throwing never escapes dispose, escalation still scheduled", () => {
	const clock = fakeClock();
	const children: StubbornChild[] = [];
	const spawnFn: SpawnFn = () => {
		const child = fakeSpawnChild() as StubbornChild;
		child.signals = [];
		child.kill = (signal?: string) => {
			child.signals.push(signal ?? "SIGTERM");
			throw new Error("ESRCH");
		};
		children.push(child);
		return child;
	};
	const runner = new StatuslineRunner({ command: "x", debounceMs: 5, timeoutMs: 10_000, spawnFn, scheduler: clock.scheduler });
	runner.request("{}", 80);
	clock.advance(5);
	assert.doesNotThrow(() => runner.dispose());
	assert.deepEqual(children[0]!.signals, ["SIGTERM"]);
	clock.advance(750);
	assert.deepEqual(children[0]!.signals, ["SIGTERM", "SIGKILL"]);
});

test("E8: an 'error' event settles the run as a failure AND completes the termination flow", () => {
	const { spawnFn, children } = stubbornSpawn();
	const clock = fakeClock();
	const runner = new StatuslineRunner({ command: "x", debounceMs: 5, timeoutMs: 10_000, spawnFn, scheduler: clock.scheduler });
	runner.request("{}", 80);
	clock.advance(5);
	children[0]!.fail(new Error("EPIPE"));
	assert.equal(runner.hasPersistentError(), false); // failure #1 only
	clock.advance(750);
	assert.ok(children[0]!.signals.includes("SIGKILL"), "ordinary error still escalates");
	// 'error' after exit is informational only — no extra kills.
	const { children: c2 } = stubbornSpawn();
	void c2;
});

test("E8: late stdout after dispose produces no update and no respawn; a new runner is unaffected", () => {
	const { spawnFn, children } = stubbornSpawn();
	const clock = fakeClock();
	const runnerA = new StatuslineRunner({ command: "a", debounceMs: 5, timeoutMs: 10_000, spawnFn, scheduler: clock.scheduler });
	let updatesB = 0;
	const runnerB = new StatuslineRunner({ command: "b", debounceMs: 5, timeoutMs: 10_000, spawnFn, scheduler: clock.scheduler });
	runnerB.setOnUpdate(() => updatesB++);
	runnerA.request("{}", 80);
	clock.advance(5);
	runnerA.dispose();
	// Late traffic on A's dead child: data, exit, even a new request.
	children[0]!.data("ghost\n");
	children[0]!.exit(0);
	runnerA.request("{}", 80);
	clock.advance(1_000);
	assert.deepEqual(runnerA.getRenderLines(), [], "disposed runner keeps no output");
	assert.equal(children.length, 1, "no respawn after dispose");
	// Runner B works normally on the same clock.
	runnerB.request("{}", 80);
	clock.advance(5);
	children[1]!.data("b\n");
	children[1]!.exit(0);
	assert.deepEqual(runnerB.getRenderLines(), ["b"]);
	assert.equal(updatesB, 1);
	runnerB.dispose();
});

test("E5: every timer the runner creates is unref'd (debounce, timeout, escalation)", () => {
	const { spawnFn } = stubbornSpawn();
	const clock = fakeClock();
	const runner = new StatuslineRunner({ command: "x", debounceMs: 5, timeoutMs: 30, spawnFn, scheduler: clock.scheduler });
	runner.request("{}", 80);
	clock.advance(5);
	clock.advance(30); // timeout → TERM + escalation
	runner.dispose(); // dispose escalation on top
	assert.ok(clock.allUnrefed(), "all created timers called unref()");
});

test("E5: a disposed runner never starts a process again", () => {
	const { spawnFn, children } = stubbornSpawn();
	const clock = fakeClock();
	const runner = new StatuslineRunner({ command: "x", debounceMs: 5, spawnFn, scheduler: clock.scheduler });
	runner.dispose();
	runner.request("{}", 80);
	clock.advance(1_000);
	assert.equal(children.length, 0);
});
