// P0 夹具捕获：subagent Fleet 底栏（fork surface-tuning @ 0ebb9c83）在各状态/宽度下的渲染。
//
// 运行：node spec/fixtures/capture-fleet-status.mjs
// 产物：spec/fixtures/fleet/*.txt（plain = 无色结构；tone = ⟦语义色⟧ 标记）。
//
// 关键约束：
// - 经安装副本绝对路径 import，其传递依赖（pi-tui 0.87.0 等）从安装副本 node_modules 解析，
//   与上游 test/unit/fleet-status.test.ts 环境一致；本仓库 node_modules 的 pi-tui 1.0.1 不参与。
// - editorHasFocus() 是结构化鸭子检查（fleet-status.ts:1018），focusedComponent 用鸭子对象即可。
// - Date.now 固定，输出确定性。

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const INSTALLED = "/Users/gd32/.pi/agent/git/github.com/GeorgeDong32/pi-subagents";
const { SubagentFleetStatus } = await import(`${INSTALLED}/src/tui/fleet-status.ts`);

const NOW = 1_000_000_000_000;
const originalNow = Date.now;
Date.now = () => NOW;

const plainTheme = {
	fg: (_name, text) => text,
	bg: (_name, text) => text,
	bold: (text) => text,
	getThinkingBorderColor: (_level) => (text) => text,
};
const toneTheme = {
	fg: (name, text) => `⟦${name}⟧${text}⟦/fg⟧`,
	bg: (name, text) => `⟦bg:${name}⟧${text}⟦/bg⟧`,
	bold: (text) => `⟦bold⟧${text}⟦/bold⟧`,
	getThinkingBorderColor: (level) => (text) => `⟦thinking:${level}⟧${text}⟦/⟧`,
};

function stateForTest() {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

const duckEditor = { render() {}, invalidate() {}, handleInput() {}, getText() { return ""; }, setText() {} };

function mount(state, theme) {
	let widgetFactory;
	const ctx = {
		hasUI: true,
		ui: {
			setWidget(_key, content) { if (content) widgetFactory = content; },
			onTerminalInput() { return () => {}; },
			getEditorText() { return ""; },
			requestRender() {},
			notify() {},
			theme,
		},
	};
	const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
	fleet.setContext(ctx);
	const component = widgetFactory({ requestRender() {}, focusedComponent: duckEditor }, theme);
	return { fleet, component };
}

function renderBlock(component, fleet, width) {
	fleet.refresh();
	return component.render(width).join("\n");
}

const WIDTHS = [20, 40, 60, 80, 120];

// ---- 场景 ----

function scenarioSingleAgents() {
	const state = stateForTest();
	state.asyncJobs.set("reviewer", {
		asyncId: "reviewer", asyncDir: "/tmp/reviewer", status: "running", startedAt: NOW - 16_000, mode: "single",
		steps: [{ index: 0, agent: "reviewer", status: "running", tokens: { input: 7_900, output: 200, total: 8_100, window: 7_400 } }],
	});
	state.asyncJobs.set("tester", {
		asyncId: "tester", asyncDir: "/tmp/tester", status: "failed", startedAt: NOW - 40_000, endedAt: NOW - 5_000, mode: "single",
		steps: [{ index: 0, agent: "tester", status: "failed", tokens: { input: 2_900, output: 100, total: 3_000, window: 2_800 } }],
	});
	state.asyncJobs.set("writer", {
		asyncId: "writer", asyncDir: "/tmp/writer", status: "running", startedAt: NOW - 25_000, mode: "single",
		steps: [{ index: 0, agent: "writer", status: "running" }],
	});
	return state;
}

function scenarioWorkflowTree() {
	const usage = { input: 119_000, output: 200, total: 119_200, window: 118_900 };
	const state = stateForTest();
	state.asyncJobs.set("wf", {
		asyncId: "wf", asyncDir: "/tmp/wf", mode: "workflow", status: "running", startedAt: NOW - 60_000,
		steps: [
			{ agent: "reviewer", workflowKey: "review", status: "running", tokens: usage },
			{ agent: "scout", workflowKey: "collect", status: "complete", startedAt: NOW - 50_000, endedAt: NOW - 42_000, durationMs: 8_000, tokens: { input: 2_300, output: 100, total: 2_400, window: 2_200 } },
			{ agent: "tester", workflowKey: "verify", status: "pending" },
		],
		totalTokens: usage,
	});
	state.asyncJobs.set("child", {
		asyncId: "child", asyncDir: "/tmp/child", mode: "single", status: "running", startedAt: NOW - 12_000,
		parentWorkflowRunId: "wf", workflowKey: "review",
		steps: [{ agent: "reviewer", status: "running", tokens: usage }],
	});
	return state;
}

function scenarioNested() {
	const state = stateForTest();
	state.asyncJobs.set("owner", {
		asyncId: "owner", asyncDir: "/tmp/owner", status: "running", startedAt: NOW - 30_000, mode: "single",
		steps: [{ index: 0, agent: "owner", status: "running" }],
		nestedChildren: [
			{
				id: "nested", parentRunId: "owner", parentStepIndex: 0, depth: 1, path: [{ runId: "owner", stepIndex: 0 }],
				state: "running", mode: "parallel",
				steps: [
					{ index: 0, agent: "scout", status: "complete", startedAt: NOW - 28_000, endedAt: NOW - 20_000, durationMs: 8_000, tokens: { input: 2_300, output: 100, total: 2_400, window: 2_200 } },
					{ index: 1, agent: "tester", status: "running", startedAt: NOW - 12_000, tokens: { input: 2_900, output: 100, total: 3_000, window: 2_800 } },
				],
			},
		],
	});
	return state;
}

function scenarioForeground() {
	const state = stateForTest();
	state.foregroundControls.set("fg1", {
		runId: "fg1", mode: "single", description: "检查展示接口", startedAt: NOW - 16_000,
		tokens: 8_100, window: 7_400, currentAgent: "reviewer",
		activeChildren: new Map([
			[0, { index: 0, agent: "reviewer", description: "检查展示接口", startedAt: NOW - 16_000, tokens: 8_100, window: 7_400 }],
			[1, { index: 1, agent: "tester", description: "验证 reload", startedAt: NOW - 12_000, tokens: 3_000, window: 2_800 }],
		]),
	});
	return state;
}

function scenarioOverflow() {
	const state = stateForTest();
	for (let i = 1; i <= 8; i++) {
		state.asyncJobs.set(`agent-${i}`, {
			asyncId: `agent-${i}`, asyncDir: `/tmp/a${i}`, status: "running", startedAt: NOW - i * 3_000, mode: "single",
			steps: [{ index: 0, agent: `agent-${i}`, status: "running", tokens: { input: i * 900, output: 100, total: i * 1000, window: i * 900 } }],
		});
	}
	return state;
}

const SCENARIOS = [
	["single-agents", scenarioSingleAgents, []],
	["workflow-tree", scenarioWorkflowTree, []],
	["nested-run", scenarioNested, []],
	["foreground-children", scenarioForeground, []],
	["row-budget-overflow", scenarioOverflow, []],
];

// 选择交互：逐步按键，逐步留档
const SELECTION_STEPS = ["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[A"];

// ---- 主流程 ----

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "fleet");
mkdirSync(outDir, { recursive: true });

try {
	for (const [themeName, theme] of [["plain", plainTheme], ["tone", toneTheme]]) {
		for (const [name, build] of SCENARIOS) {
			const state = build();
			const { fleet, component } = mount(state, theme);
			let out = [`# ${name} [${themeName}] — fork surface-tuning @ 0ebb9c83, Date.now=${NOW}\n`];
			for (const width of WIDTHS) out.push(`\n===== width=${width} =====\n${renderBlock(component, fleet, width)}\n`);
			fleet.dispose();
			writeFileSync(path.join(outDir, `${name}.${themeName}.txt`), out.join("\n"));
		}
	}

	// 选择交互记录（plain + 80 列；含每步后的完整渲染）
	{
		const state = scenarioSingleAgents();
		const { fleet, component } = mount(state, plainTheme);
		let out = [`# selection-walk [plain] — 按 ↓↓↓↑ 逐步渲染，width=80, Date.now=${NOW}\n`];
		out.push(`\n===== 初始（未激活） =====\n${renderBlock(component, fleet, 80)}\n`);
		for (const [i, key] of SELECTION_STEPS.entries()) {
			fleet.handleKey(key);
			out.push(`\n===== 按键 ${JSON.stringify(key)}（第 ${i + 1} 步） =====\n${renderBlock(component, fleet, 80)}\n`);
		}
		fleet.dispose();
		writeFileSync(path.join(outDir, "selection-walk.plain.txt"), out.join("\n"));
	}

	console.log(`fixtures written to ${outDir}`);
} finally {
	Date.now = originalNow;
}
