import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../../extensions/subagent/agents.ts";
import { FifoGate, type SubagentDetails, type SubagentThread } from "../../../extensions/subagent/run.ts";

const createSubagentThread = vi.fn();
const disposeSubagentThread = vi.fn(async () => undefined);
const runSubagentTurn = vi.fn();

vi.mock("../../../extensions/subagent/run.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../extensions/subagent/run.ts")>();
	return {
		...actual,
		createSubagentThread: ((...args: unknown[]) =>
			createSubagentThread(...(args as []))) as typeof actual.createSubagentThread,
		disposeSubagentThread: ((...args: unknown[]) =>
			disposeSubagentThread(...(args as []))) as typeof actual.disposeSubagentThread,
		runSubagentTurn: ((...args: unknown[]) => runSubagentTurn(...(args as []))) as typeof actual.runSubagentTurn,
	};
});

const { SubagentRuntime } = await import("../../../extensions/subagent/runtime.ts");

const definition: AgentDefinition = {
	name: "scout",
	description: "Scout",
	tools: ["read"],
	names: ["Pathfinder", "Trailblazer", "Lookout", "Tracker", "Ranger"],
	prompt: "look",
	path: "/agents/scout.md",
};

const standardUsage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
};

function fakeSession(): AgentSession {
	return {
		isStreaming: false,
		async abort() {},
		dispose() {},
		subscribe() {
			return () => undefined;
		},
		async prompt() {},
		getActiveToolNames: () => ["read"],
	} as unknown as AgentSession;
}

function makeThread(id: string, overrides: Partial<SubagentThread> = {}): SubagentThread {
	return {
		id,
		displayName: "Pathfinder",
		definition,
		session: fakeSession(),
		cwd: "/project",
		model: "provider/model",
		thinkingLevel: "medium",
		initialTask: "task",
		turns: 0,
		turnGate: new FifoGate(1),
		pendingTurns: 0,
		lastUsedAt: 0,
		...overrides,
	};
}

function ctx(): ExtensionContext {
	return {
		cwd: "/project",
		mode: "print",
		hasUI: false,
		model: { provider: "provider", id: "model" },
		ui: { notify() {} },
		isProjectTrusted: () => true,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		},
	} as unknown as ExtensionContext;
}

function pi(): ExtensionAPI {
	return {
		getAllTools: () => [{ name: "read", sourceInfo: { path: "/ext/read.ts" } }],
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI;
}

function completedDetails(threadId: string): SubagentDetails {
	return {
		agent: "scout",
		displayName: "Pathfinder",
		threadId,
		status: "completed",
		phase: "output",
		task: "task",
		model: "provider/model",
		thinkingLevel: "medium",
		response: "done",
		toolCalls: 0,
		actions: [],
		omittedActions: 0,
		omittedErrors: 0,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		durationMs: 1,
	};
}

function execArgs(task: string, continuing = false, threadKey?: string) {
	return {
		agent: continuing ? (threadKey ?? task) : "scout",
		task,
		continuing,
		threadKey,
		ctx: ctx(),
		parentModel: "provider/model",
		parentThinking: "medium",
		resolveFreshDefinition: async () => ({ ok: true as const, definition }),
	};
}

function mockCompletedTurn() {
	runSubagentTurn.mockImplementation(async (options: { thread: SubagentThread }) => ({
		content: "ok",
		details: completedDetails(options.thread.id),
		retainable: true,
		usage: standardUsage,
	}));
}

function mockBlockedCreate(releaseRef: { current?: () => void }) {
	createSubagentThread.mockImplementation(async (options: { id: string }) => {
		await new Promise<void>((resolve) => {
			releaseRef.current = resolve;
		});
		return makeThread(options.id);
	});
}

async function seedThread(runtime: InstanceType<typeof SubagentRuntime>, lastUsedAt: number) {
	createSubagentThread.mockImplementationOnce(async (options: { id: string }) =>
		makeThread(options.id, { lastUsedAt }),
	);
	runSubagentTurn.mockImplementationOnce(async (options: { thread: SubagentThread }) => {
		options.thread.turns = 1;
		options.thread.lastUsedAt = lastUsedAt;
		return {
			content: "ok",
			details: completedDetails(options.thread.id),
			retainable: true,
		};
	});
	const result = await runtime.execute(execArgs(`seed-${lastUsedAt}`));
	const retainedId = result.details.threadId;
	if (!retainedId) throw new Error("seed did not retain a thread");
	return { retainedId, result };
}

describe("SubagentRuntime", () => {
	beforeEach(() => {
		createSubagentThread.mockReset();
		disposeSubagentThread.mockReset();
		disposeSubagentThread.mockResolvedValue(undefined);
		runSubagentTurn.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("never exceeds 16 retained or reserved slots under concurrent fresh calls", async () => {
		const runtime = new SubagentRuntime(pi());
		let created = 0;
		let maxCapacity = 0;
		const track = () => {
			maxCapacity = Math.max(maxCapacity, runtime.capacityInUse);
		};
		// Hold every create until all 20 execute paths have attempted reservation.
		let releaseCreates: (() => void) | undefined;
		const createsHeld = new Promise<void>((resolve) => {
			releaseCreates = resolve;
		});
		let sawSixteen = false;
		let resolveSixteen: (() => void) | undefined;
		const reachedSixteen = new Promise<void>((resolve) => {
			resolveSixteen = resolve;
		});
		createSubagentThread.mockImplementation(async (options: { id: string }) => {
			created += 1;
			track();
			if (runtime.capacityInUse >= 16 && !sawSixteen) {
				sawSixteen = true;
				resolveSixteen?.();
			}
			await createsHeld;
			track();
			return makeThread(options.id);
		});
		runSubagentTurn.mockImplementation(async (options: { thread: SubagentThread }) => {
			options.thread.turns = 1;
			track();
			return {
				content: "ok",
				details: completedDetails(options.thread.id),
				retainable: true,
			};
		});

		const starts = Array.from({ length: 20 }, (_, index) =>
			runtime
				.execute({
					agent: "scout",
					task: `task-${index}`,
					continuing: false,
					ctx: ctx(),
					parentModel: "provider/model",
					parentThinking: "medium",
					resolveFreshDefinition: async () => {
						track();
						return { ok: true, definition };
					},
				})
				.then((result) => {
					track();
					return result;
				}),
		);

		await reachedSixteen;
		expect(runtime.capacityInUse).toBeLessThanOrEqual(16);
		expect(created).toBeLessThanOrEqual(16);
		releaseCreates?.();
		const results = await Promise.all(starts);
		expect(maxCapacity).toBeLessThanOrEqual(16);
		expect(results.filter((item) => item.details.status === "failed")).toHaveLength(4);
		expect(runtime.retainedCount).toBeLessThanOrEqual(16);
		await runtime.shutdown();
	});

	it("reserves a continuation before awaits so it cannot be evicted", async () => {
		const runtime = new SubagentRuntime(pi());
		const first = await seedThread(runtime, 1);
		const retainedId = first.retainedId;
		expect(runtime.retainedCount).toBe(1);
		const retained = runtime.listThreads("/project")[0];
		expect(retained?.id).toBe(retainedId);

		// Fill to capacity with newer idle threads.
		for (let index = 0; index < 15; index += 1) {
			await seedThread(runtime, 100 + index);
		}
		expect(runtime.retainedCount).toBe(16);

		let seenPending = 0;
		let releaseContinuation: (() => void) | undefined;
		runSubagentTurn.mockImplementation(async (options: { thread: SubagentThread; task: string }) => {
			if (options.task === "follow-up") {
				seenPending = options.thread.pendingTurns;
				await new Promise<void>((resolve) => {
					releaseContinuation = resolve;
				});
			}
			options.thread.turns += 1;
			return {
				content: "ok",
				details: completedDetails(options.thread.id),
				retainable: true,
			};
		});

		const continuation = runtime.execute({
			agent: retainedId,
			task: "follow-up",
			continuing: true,
			threadKey: retainedId,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		await vi.waitFor(() => expect(releaseContinuation).toBeTypeOf("function"));
		expect(seenPending).toBeGreaterThan(0);

		// Fresh call at capacity must not evict the reserved continuation target.
		createSubagentThread.mockImplementation(async (options: { id: string }) => makeThread(options.id));
		const fresh = runtime.execute({
			agent: "scout",
			task: "another",
			continuing: false,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		await vi.waitFor(() => expect(createSubagentThread).toHaveBeenCalled());
		expect(runtime.listThreads("/project").some((thread) => thread.id === retainedId)).toBe(true);
		releaseContinuation?.();
		await Promise.all([continuation, fresh]);
		expect(runtime.listThreads("/project").some((thread) => thread.id === retainedId)).toBe(true);
		await runtime.shutdown();
	});

	it("disposes failed and aborted initial turns without advertising reuse", async () => {
		const runtime = new SubagentRuntime(pi());
		createSubagentThread.mockImplementation(async (options: { id: string }) => makeThread(options.id));
		runSubagentTurn.mockResolvedValueOnce({
			content: "boom",
			details: { ...completedDetails("x"), status: "failed", error: "boom" },
			retainable: true,
		});
		const failed = await runtime.execute({
			agent: "scout",
			task: "fail",
			continuing: false,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		expect(failed.content[0]?.text).not.toContain("Reuse with subagent");
		expect(runtime.retainedCount).toBe(0);
		expect(disposeSubagentThread).toHaveBeenCalled();

		runSubagentTurn.mockResolvedValueOnce({
			content: "aborted",
			details: { ...completedDetails("y"), status: "aborted", error: "aborted" },
			retainable: true,
		});
		const aborted = await runtime.execute({
			agent: "scout",
			task: "abort",
			continuing: false,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		expect(aborted.content[0]?.text).not.toContain("Reuse with subagent");
		expect(runtime.retainedCount).toBe(0);
		await runtime.shutdown();
	});

	it("fences late startup after reset so threads do not publish into the next generation", async () => {
		const runtime = new SubagentRuntime(pi());
		const release = { current: undefined as (() => void) | undefined };
		mockBlockedCreate(release);
		mockCompletedTurn();
		const first = runtime.execute(execArgs("slow-start"));
		await vi.waitFor(() => expect(release.current).toBeTypeOf("function"));
		const generationBefore = runtime.currentGeneration;
		const resetting = runtime.reset();
		// Unblock startup so the aborted generation can finish; reset awaits active runs.
		release.current?.();
		await resetting;
		expect(runtime.currentGeneration).toBe(generationBefore + 1);
		const result = await first;
		expect(result.details.status).toBe("aborted");
		expect(runtime.retainedCount).toBe(0);
		expect(disposeSubagentThread).toHaveBeenCalled();
		await runtime.shutdown();
	});

	it("shutdown aborts active calls and disposes created sessions", async () => {
		const runtime = new SubagentRuntime(pi());
		let releasePrompt: (() => void) | undefined;
		createSubagentThread.mockImplementation(async (options: { id: string }) => makeThread(options.id));
		runSubagentTurn.mockImplementation(async (options: { thread: SubagentThread }) => {
			await new Promise<void>((resolve) => {
				releasePrompt = resolve;
			});
			return {
				content: "ok",
				details: completedDetails(options.thread.id),
				retainable: true,
			};
		});
		const running = runtime.execute({
			agent: "scout",
			task: "live",
			continuing: false,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		await vi.waitFor(() => expect(runSubagentTurn).toHaveBeenCalled());
		const shuttingDown = runtime.shutdown();
		releasePrompt?.();
		await shuttingDown;
		await running;
		expect(disposeSubagentThread).toHaveBeenCalled();
		expect(runtime.retainedCount).toBe(0);
	});

	it("keeps same-thread turns sequential", async () => {
		const runtime = new SubagentRuntime(pi());
		const seeded = await seedThread(runtime, 1);
		const threadId = seeded.retainedId;
		const order: string[] = [];
		const gates: Record<string, () => void> = {};
		runSubagentTurn.mockImplementation(async (options: { thread: SubagentThread; task: string }) => {
			order.push(`start:${options.task}`);
			await new Promise<void>((resolve) => {
				gates[options.task] = resolve;
			});
			order.push(`end:${options.task}`);
			options.thread.turns += 1;
			return {
				content: options.task,
				details: completedDetails(options.thread.id),
				retainable: true,
			};
		});

		const first = runtime.execute({
			agent: threadId,
			task: "A",
			continuing: true,
			threadKey: threadId,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		await vi.waitFor(() => expect(order).toContain("start:A"));
		const second = runtime.execute({
			agent: threadId,
			task: "B",
			continuing: true,
			threadKey: threadId,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(order).toEqual(["start:A"]);
		gates.A?.();
		await first;
		await vi.waitFor(() => expect(order).toContain("start:B"));
		gates.B?.();
		await second;
		expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
		await runtime.shutdown();
	});

	it("publishes immutable snapshots with distinct invocation ids", async () => {
		const runtime = new SubagentRuntime(pi());
		const snapshots: Array<{ id: string; status: string; task: string }> = [];
		const observerB: string[] = [];
		runtime.subscribe((snap) => {
			snapshots.push({ id: snap.invocationId, status: snap.status, task: snap.task });
			snap.status = "failed";
			snap.task = "mutated";
		});
		runtime.subscribe((snap) => {
			observerB.push(snap.task);
		});
		createSubagentThread.mockImplementation(async (options: { id: string }) => makeThread(options.id));
		runSubagentTurn.mockImplementation(
			async (options: { thread: SubagentThread; onUpdate?: (d: SubagentDetails) => void }) => {
				await options.onUpdate?.({
					...completedDetails(options.thread.id),
					status: "running",
					phase: "run",
					response: "partial",
				});
				await options.onUpdate?.({
					...completedDetails(options.thread.id),
					status: "completed",
					phase: "output",
					response: "ok",
				});
				options.thread.turns += 1;
				return {
					content: "ok",
					details: completedDetails(options.thread.id),
					retainable: true,
				};
			},
		);

		const first = await runtime.execute({
			agent: "scout",
			task: "one",
			continuing: false,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		const threadId = first.details.threadId;
		expect(threadId).toBeTruthy();
		const second = await runtime.execute({
			agent: threadId ?? "",
			task: "two",
			continuing: true,
			threadKey: threadId,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});

		expect(first.details.invocationId).toBeTruthy();
		expect(second.details.invocationId).toBeTruthy();
		expect(first.details.invocationId).not.toBe(second.details.invocationId);
		expect(new Set(snapshots.map((item) => item.id)).size).toBe(2);
		expect(snapshots.some((item) => item.status === "waiting")).toBe(true);
		expect(snapshots.some((item) => item.task === "one")).toBe(true);
		expect(observerB.every((task) => task !== "mutated")).toBe(true);
		const firstStatuses = snapshots
			.filter((item) => item.id === first.details.invocationId)
			.map((item) => item.status);
		expect(firstStatuses.filter((status) => status === "completed").length).toBeLessThanOrEqual(1);
		await runtime.shutdown();
	});

	it("passes requested autoread files to the child turn", async () => {
		const runtime = new SubagentRuntime(pi());
		createSubagentThread.mockImplementation(async (options: { id: string }) => makeThread(options.id));
		let received: { files?: readonly string[]; invocationId?: string } | undefined;
		runSubagentTurn.mockImplementation(
			async (options: { thread: SubagentThread; files?: readonly string[]; invocationId?: string }) => {
				received = { files: options.files, invocationId: options.invocationId };
				options.thread.turns += 1;
				return {
					content: "ok",
					details: completedDetails(options.thread.id),
					retainable: true,
				};
			},
		);

		const result = await runtime.execute({
			...execArgs("inspect"),
			files: ["src/runtime.ts", "test/runtime.test.ts"],
		});

		expect(received?.files).toEqual(["src/runtime.ts", "test/runtime.test.ts"]);
		expect(received?.invocationId).toBe(result.details.invocationId);
		await runtime.shutdown();
	});

	it("preserves standard usage on fresh and continued tool results", async () => {
		const runtime = new SubagentRuntime(pi());
		createSubagentThread.mockImplementation(async (options: { id: string }) => makeThread(options.id));
		mockCompletedTurn();

		const fresh = await runtime.execute(execArgs("fresh"));
		const threadId = fresh.details.threadId;
		if (!threadId) throw new Error("fresh thread was not retained");
		const continued = await runtime.execute(execArgs("continued", true, threadId));

		expect(fresh.usage).toEqual(standardUsage);
		expect(continued.usage).toEqual(standardUsage);
		await runtime.shutdown();
	});

	it("gives batched agents unique names and suffixes a reused pool name", async () => {
		const runtime = new SubagentRuntime(pi());
		createSubagentThread.mockImplementation(async (options: { id: string; displayName: string }) =>
			makeThread(options.id, { displayName: options.displayName }),
		);
		mockCompletedTurn();

		const results = await Promise.all(
			Array.from({ length: 6 }, (_, index) => runtime.execute(execArgs(`batch-${index}`))),
		);
		expect(results.map((result) => result.details.displayName)).toEqual([
			"Pathfinder",
			"Trailblazer",
			"Lookout",
			"Tracker",
			"Ranger",
			"Pathfinder-2",
		]);
		expect(new Set(results.map((result) => result.details.displayName)).size).toBe(6);

		const firstThread = results[0]?.details.threadId;
		if (!firstThread) throw new Error("first batched agent was not retained");
		const continuation = await runtime.execute(execArgs("follow-up", true, firstThread));
		expect(continuation.details.displayName).toBe("Pathfinder");
		await runtime.shutdown();
	});

	it("fails queued continuations after a non-retainable turn disposes the thread", async () => {
		const runtime = new SubagentRuntime(pi());
		const seeded = await seedThread(runtime, 1);
		const threadId = seeded.retainedId;
		let releaseFirst: (() => void) | undefined;
		runSubagentTurn.mockImplementation(async (options: { thread: SubagentThread; task: string }) => {
			if (options.task === "bad") {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
				options.thread.turns += 1;
				return {
					content: "broken",
					details: { ...completedDetails(options.thread.id), status: "failed", error: "broken" },
					retainable: false,
				};
			}
			options.thread.turns += 1;
			return {
				content: "should-not-run",
				details: completedDetails(options.thread.id),
				retainable: true,
			};
		});
		const first = runtime.execute({
			agent: threadId,
			task: "bad",
			continuing: true,
			threadKey: threadId,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
		const second = runtime.execute({
			agent: threadId,
			task: "queued",
			continuing: true,
			threadKey: threadId,
			ctx: ctx(),
			parentModel: "provider/model",
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true, definition }),
		});
		releaseFirst?.();
		const [a, b] = await Promise.all([first, second]);
		expect(a.details.status).toBe("failed");
		expect(b.details.status === "failed" || b.details.status === "aborted").toBe(true);
		expect(b.content[0]?.text).toMatch(/unavailable|aborted|failed/i);
		expect(runSubagentTurn.mock.calls.filter((call) => call[0].task === "queued")).toHaveLength(0);
		await runtime.shutdown();
	});

	it("does not let reset-era reservation tokens undercount the next generation", async () => {
		const runtime = new SubagentRuntime(pi());
		const release = { current: undefined as (() => void) | undefined };
		mockBlockedCreate(release);
		mockCompletedTurn();
		const stuck = runtime.execute(execArgs("stuck"));
		await vi.waitFor(() => expect(release.current).toBeTypeOf("function"));
		expect(runtime.capacityInUse).toBe(1);
		const resetting = runtime.reset();
		release.current?.();
		await stuck;
		await resetting;
		// Old reservation must be gone; new generation starts empty.
		expect(runtime.capacityInUse).toBe(0);

		createSubagentThread.mockImplementation(async (options: { id: string }) => makeThread(options.id));
		for (let index = 0; index < 16; index += 1) await runtime.execute(execArgs(`n-${index}`));
		expect(runtime.retainedCount).toBe(16);
		const overflow = await runtime.execute(execArgs("overflow"));
		// At capacity with all busy/retained — either evicts idle or fails; never exceeds 16 retained+reserved mid-flight after settle.
		expect(runtime.capacityInUse).toBeLessThanOrEqual(16);
		expect(overflow.details.status === "completed" || overflow.details.status === "failed").toBe(true);
		await runtime.shutdown();
	});
});
