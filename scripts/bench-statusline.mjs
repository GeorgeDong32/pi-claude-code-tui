#!/usr/bin/env node
// Statusline performance gate (plan SL5/§7): measure spawn+render wall time
// for the bundled default script or a user command.
//
//   node scripts/bench-statusline.mjs                 # bundled default script
//   node scripts/bench-statusline.mjs ~/.claude/statusline-command.sh
//
// Gate: default script p95 < 50ms; a user script p95 < 250ms. Refreshes are
// event-driven (a few per minute), so even slower scripts stay off the hot
// path — the numbers document headroom, they do not block on their own.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const userCommand = process.argv.slice(2).join(" ").trim();
const command = userCommand || `bash '${join(here, "statusline-default.sh")}'`;

const SAMPLE_JSON = JSON.stringify({
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

const runOnce = () =>
	new Promise((resolve, reject) => {
		const t0 = process.hrtime.bigint();
		const child = spawn("bash", ["-c", command], {
			env: { ...process.env, OVERRIDE_TERM_WIDTH: "120" },
		});
		let settled = false;
		const finish = (err) => {
			if (settled) return;
			settled = true;
			if (err) reject(err);
			else resolve(Number(process.hrtime.bigint() - t0) / 1e6);
		};
		child.on("error", finish);
		child.on("exit", () => finish());
		child.stdin.on("error", () => {}); // fast-exiting scripts can close early
		child.stdin.end(SAMPLE_JSON);
	});

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

// Warmup (page cache, first spawn) then 50 samples.
for (let i = 0; i < 3; i++) await runOnce();
const samples = [];
for (let i = 0; i < 50; i++) samples.push(await runOnce());
samples.sort((a, b) => a - b);

console.log(`command: ${command}`);
console.log(`samples: ${samples.length}`);
console.log(`min    : ${samples[0].toFixed(1)}ms`);
console.log(`p50    : ${percentile(samples, 50).toFixed(1)}ms`);
console.log(`p95    : ${percentile(samples, 95).toFixed(1)}ms`);
console.log(`max    : ${samples[samples.length - 1].toFixed(1)}ms`);
const gate = userCommand ? 250 : 50;
const p95 = percentile(samples, 95);
console.log(`gate   : p95 < ${gate}ms → ${p95 < gate ? "PASS" : "OVER (see README: switch scripts)"}`);
