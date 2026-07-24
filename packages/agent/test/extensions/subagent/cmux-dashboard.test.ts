import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
	createCmuxDashboard,
	formatDashboardMarkdown,
	type CmuxClock,
	type CmuxExec,
} from "../../../extensions/subagent/cmux-dashboard.ts";
import type { SubagentInvocationSnapshot } from "../../../extensions/subagent/run.ts";

function snapshot(overrides: Partial<SubagentInvocationSnapshot> = {}): SubagentInvocationSnapshot {
	return {
		invocationId: "inv-1",
		startedAt: 1000,
		agent: "scout",
		displayName: "Pathfinder",
		threadId: "thread-1",
		status: "running",
		phase: "run",
		task: "Find the gate",
		model: "provider/model",
		thinkingLevel: "high",
		toolCalls: 1,
		actions: [{ tool: "read", summary: "read run.ts", error: false }],
		omittedActions: 0,
		omittedErrors: 0,
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		durationMs: 1500,
		currentActivity: "read run.ts",
		files: [],
		...overrides,
	};
}

class FakeClock implements CmuxClock {
	nowMs = 0;
	readonly timers = new Map<number, { due: number; handler: () => void }>();
	private nextId = 1;
	now() {
		return this.nowMs;
	}
	setTimeout(handler: () => void, ms: number) {
		const id = this.nextId++;
		this.timers.set(id, { due: this.nowMs + ms, handler });
		return id;
	}
	clearTimeout(handle: unknown) {
		this.timers.delete(handle as number);
	}
	async advance(ms: number) {
		this.nowMs += ms;
		const due = [...this.timers.entries()]
			.filter(([, timer]) => timer.due <= this.nowMs)
			.sort((a, b) => a[1].due - b[1].due);
		for (const [id, timer] of due) {
			this.timers.delete(id);
			timer.handler();
		}
		// Flush async work kicked off by timer handlers (op queue, writes, rpc).
		for (let index = 0; index < 20; index += 1) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	/** Drain write debounce, then wait for close grace timer and fire it. */
	async runCloseGrace() {
		await this.advance(150);
		await vi.waitFor(() => expect(this.timers.size).toBeGreaterThan(0));
		await this.advance(2000);
	}
}

/** cmux args: --json --id-format both rpc <method> <json> */
function parseRpc(args: string[]): { method: string; params: Record<string, unknown> } {
	const rpcIndex = args.indexOf("rpc");
	return {
		method: args[rpcIndex + 1] ?? "",
		params: JSON.parse(String(args[rpcIndex + 2] ?? "{}")) as Record<string, unknown>,
	};
}

const CMUX_ENV = { CMUX_WORKSPACE_ID: "ws", CMUX_SURFACE_ID: "parent" };

function okResult(stdout = "{}") {
	return { stdout, stderr: "", code: 0, killed: false };
}

function openOkResult() {
	return okResult(JSON.stringify({ surface_id: "dash-1", workspace_id: "ws" }));
}

function recordingExec(calls: Array<{ method: string; params: Record<string, unknown> }>): CmuxExec {
	return async (_command, args) => {
		const parsed = parseRpc(args);
		calls.push(parsed);
		if (parsed.method === "markdown.open") return openOkResult();
		return okResult();
	};
}

function methodRecordingExec(calls: string[]): CmuxExec {
	return async (_command, args) => {
		const parsed = parseRpc(args);
		calls.push(parsed.method);
		if (parsed.method === "markdown.open") return openOkResult();
		return okResult();
	};
}

function interactiveDashboard(exec: CmuxExec, clock = new FakeClock()) {
	const dashboard = createCmuxDashboard({ exec, clock, env: CMUX_ENV });
	dashboard.setInteractive(true);
	return { dashboard, clock };
}

describe("formatDashboardMarkdown", () => {
	it("renders an agent table with requests and injected files", () => {
		const md = formatDashboardMarkdown([
			snapshot({ invocationId: "inv-1", agent: "../escaped", task: "one | two", files: ["src/one.ts"] }),
			snapshot({
				invocationId: "inv-2",
				startedAt: 2000,
				agent: "scout",
				task: "two",
				status: "waiting",
				phase: "queue",
			}),
		]);
		expect(md).toContain("# Subagents");
		expect(md).toContain("2 active · 0 done");
		expect(md).toContain("| Agent | State | Request | Last tool | Calls | Time |");
		expect(md).toContain("../escaped");
		expect(md).toContain("Pathfinder (../escaped)");
		expect(md).not.toContain("thread-1");
		expect(md).toContain("inv-1");
		expect(md).toContain("inv-2");
		expect(md).toContain("one");
		expect(md).toContain("two");
		expect(md).toContain("one &#124; two");
		expect(md).toContain("## Inputs");
		expect(md).toContain("src/one.ts");
		expect(md).not.toContain("provider/model");
		expect(md).not.toContain("read run.ts");
	});
});

describe("createCmuxDashboard", () => {
	it("is a no-op outside cmux and in non-interactive mode", async () => {
		const exec = vi.fn<CmuxExec>();
		const outside = createCmuxDashboard({
			exec,
			env: {},
			clock: new FakeClock(),
		});
		outside.setInteractive(true);
		outside.onSnapshot(snapshot());
		await outside.shutdown();
		expect(exec).not.toHaveBeenCalled();

		const printMode = createCmuxDashboard({
			exec,
			env: { CMUX_WORKSPACE_ID: "ws", CMUX_SURFACE_ID: "surf" },
			clock: new FakeClock(),
		});
		printMode.setInteractive(false);
		printMode.onSnapshot(snapshot());
		await printMode.shutdown();
		expect(exec).not.toHaveBeenCalled();
	});

	it("opens exactly one surface for the first invocation with parent ids and focus false", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const { dashboard, clock } = interactiveDashboard(recordingExec(calls));
		dashboard.onSnapshot(snapshot({ status: "waiting", phase: "queue" }));
		await vi.waitFor(() => expect(calls.some((call) => call.method === "markdown.open")).toBe(true));
		dashboard.onSnapshot(snapshot({ invocationId: "inv-2", status: "running", phase: "run", startedAt: 2 }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls.filter((call) => call.method === "markdown.open")).toHaveLength(1);
		expect(calls[0]?.params).toMatchObject({
			workspace_id: "ws",
			surface_id: "parent",
			direction: "right",
			focus: false,
		});
		expect(String(calls[0]?.params.path).endsWith("dashboard.md")).toBe(true);
		expect(calls.some((call) => call.method.includes("equalize"))).toBe(false);

		// Complete the cohort and close the owned surface only.
		dashboard.onSnapshot(snapshot({ status: "completed", phase: "output", response: "done" }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		dashboard.onSnapshot(
			snapshot({ invocationId: "inv-2", status: "completed", phase: "output", response: "done2", startedAt: 2 }),
		);
		await clock.runCloseGrace();
		await vi.waitFor(() => expect(calls.some((call) => call.method === "surface.close")).toBe(true));
		const close = calls.find((call) => call.method === "surface.close");
		expect(close?.params).toMatchObject({ workspace_id: "ws", surface_id: "dash-1" });
		await dashboard.shutdown();
	});

	it("cancels teardown when a call arrives during the close grace period", async () => {
		const calls: string[] = [];
		const { dashboard, clock } = interactiveDashboard(methodRecordingExec(calls));
		dashboard.onSnapshot(snapshot({ status: "running" }));
		await vi.waitFor(() => expect(calls).toContain("markdown.open"));
		dashboard.onSnapshot(snapshot({ status: "completed", phase: "output" }));
		await clock.advance(150);
		await vi.waitFor(() => expect(clock.timers.size).toBeGreaterThan(0));
		await clock.advance(1000);
		dashboard.onSnapshot(snapshot({ invocationId: "inv-2", status: "running", startedAt: 5 }));
		await clock.advance(2000);
		expect(calls.filter((method) => method === "surface.close")).toHaveLength(0);
		dashboard.onSnapshot(snapshot({ invocationId: "inv-2", status: "completed", phase: "output", startedAt: 5 }));
		await clock.runCloseGrace();
		await vi.waitFor(() => expect(calls).toContain("surface.close"));
		await dashboard.shutdown();
	});

	it("keeps completed work in the table while another invocation is running", async () => {
		let path = "";
		const exec: CmuxExec = async (_command, args) => {
			const parsed = parseRpc(args);
			if (parsed.method === "markdown.open") {
				path = String(parsed.params.path);
				return openOkResult();
			}
			return okResult();
		};
		const { dashboard, clock } = interactiveDashboard(exec);
		dashboard.onSnapshot(snapshot({ invocationId: "inv-1", task: "fast task", status: "running" }));
		dashboard.onSnapshot(snapshot({ invocationId: "inv-2", task: "slow task", status: "running", startedAt: 2000 }));
		await vi.waitFor(() => expect(path).toBeTruthy());
		dashboard.onSnapshot(
			snapshot({
				invocationId: "inv-1",
				task: "fast task",
				status: "completed",
				phase: "output",
				toolCalls: 4,
				response: "fast answer",
			}),
		);
		await clock.advance(150);
		await vi.waitFor(async () => {
			const markdown = await readFile(path, "utf8");
			expect(markdown).toContain("1 active · 1 done");
			expect(markdown).toContain("inv-1");
			expect(markdown).toContain("| Pathfinder (scout) | done | fast task | read | 4 |");
			expect(markdown).not.toContain("fast answer");
			expect(markdown).toContain("inv-2");
		});
		await dashboard.shutdown();
	});

	it("disables after malformed open output and keeps directory when surface id is unknown", async () => {
		const notifications: string[] = [];
		let openPath = "";
		const exec: CmuxExec = async (_command, args) => {
			const parsed = parseRpc(args);
			if (parsed.method === "markdown.open") {
				openPath = String(parsed.params.path);
				return { stdout: "not-json", stderr: "", code: 0, killed: false };
			}
			return { stdout: "{}", stderr: "", code: 0, killed: false };
		};
		const dashboard = createCmuxDashboard({
			exec,
			clock: new FakeClock(),
			env: { CMUX_WORKSPACE_ID: "ws", CMUX_SURFACE_ID: "parent" },
			notify: (message) => notifications.push(message),
		});
		dashboard.setInteractive(true);
		dashboard.onSnapshot(snapshot({ status: "waiting", phase: "queue" }));
		await vi.waitFor(() => expect(notifications.length).toBe(1));
		expect(openPath.endsWith("dashboard.md")).toBe(true);
		const directory = openPath.slice(0, -"dashboard.md".length);
		await expect(access(directory)).resolves.toBeUndefined();
		const opensBefore = 1;
		dashboard.onSnapshot(snapshot({ invocationId: "inv-2", status: "running" }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		// still disabled — no second successful open path change required; notify stayed once
		expect(notifications).toHaveLength(opensBefore);
		await dashboard.shutdown();
		// Ambiguous open keeps the file after shutdown — surface may still reference it.
		await expect(access(directory)).resolves.toBeUndefined();
	});

	it("keeps ownership and file when close fails, including shutdown", async () => {
		let path = "";
		const exec: CmuxExec = async (_command, args) => {
			const parsed = parseRpc(args);
			if (parsed.method === "markdown.open") {
				path = String(parsed.params.path);
				return openOkResult();
			}
			if (parsed.method === "surface.close") return { stdout: "", stderr: "busy", code: 2, killed: false };
			return okResult();
		};
		const { dashboard, clock } = interactiveDashboard(exec);
		dashboard.onSnapshot(snapshot({ status: "running" }));
		await vi.waitFor(async () => {
			expect(path).toBeTruthy();
			await expect(readFile(path, "utf8")).resolves.toContain("# Subagents");
		});
		dashboard.onSnapshot(snapshot({ status: "completed", phase: "output" }));
		await clock.runCloseGrace();
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Failed close must keep the backing file so a live surface is not blanked.
		await expect(readFile(path, "utf8")).resolves.toContain("# Subagents");
		await dashboard.shutdown();
		await expect(readFile(path, "utf8")).resolves.toContain("# Subagents");
	});

	it("canOpen false prevents opening while prior orphans remain", async () => {
		const exec = vi.fn<CmuxExec>();
		const dashboard = createCmuxDashboard({
			exec,
			clock: new FakeClock(),
			env: CMUX_ENV,
			canOpen: () => false,
		});
		dashboard.setInteractive(true);
		dashboard.onSnapshot(snapshot({ status: "running" }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(exec).not.toHaveBeenCalled();
		await dashboard.shutdown();
	});

	it("shutdown during opening leaves no runnable timers", async () => {
		let releaseOpen: (() => void) | undefined;
		const exec: CmuxExec = async (_command, args) => {
			const parsed = parseRpc(args);
			if (parsed.method === "markdown.open") {
				await new Promise<void>((resolve) => {
					releaseOpen = resolve;
				});
				return openOkResult();
			}
			return okResult();
		};
		const { dashboard, clock } = interactiveDashboard(exec);
		dashboard.onSnapshot(snapshot({ status: "running" }));
		await vi.waitFor(() => expect(releaseOpen).toBeTypeOf("function"));
		const shutdown = dashboard.shutdown();
		releaseOpen?.();
		await shutdown;
		expect(clock.timers.size).toBe(0);
	});
});
