import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { cappedTail, FifoGate, runSubagentTurn, type SubagentThread } from "../../../extensions/subagent/run.ts";

function assistant(text: string, input = 10, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "test-model",
		usage: {
			input,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: input + 9,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
		},
		stopReason,
		timestamp: 0,
	};
}

function fakeSession(options: {
	responses?: AssistantMessage[];
	onPrompt?: (text: string) => void | Promise<void>;
	abortImpl?: () => Promise<void>;
}): AgentSession {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const responses = options.responses ?? [assistant("ok")];
	let responseIndex = 0;
	return {
		isStreaming: false,
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(text: string) {
			await options.onPrompt?.(text);
			const message = responses[responseIndex++];
			if (!message) throw new Error("missing test response");
			for (const listener of listeners) {
				listener({
					type: "message_update",
					message: {
						...message,
						content: [
							{
								type: "text",
								text: message.content[0] && "text" in message.content[0] ? message.content[0].text : "",
							},
						],
					},
					assistantMessageEvent: { type: "text_delta", delta: "" },
				} as AgentSessionEvent);
				listener({ type: "message_end", message });
			}
		},
		async abort() {
			if (options.abortImpl) return options.abortImpl();
		},
		dispose() {},
	} as unknown as AgentSession;
}

function threadOf(session: AgentSession): SubagentThread {
	return {
		id: "thread-1",
		definition: {
			name: "scout",
			description: "Scout",
			tools: ["read"],
			names: ["Pathfinder"],
			prompt: "Inspect only requested files.",
			path: "/agents/scout.md",
		},
		displayName: "Pathfinder",
		session,
		cwd: "/project",
		model: "openai-codex/test-model",
		thinkingLevel: "medium",
		initialTask: "Inspect config",
		turns: 0,
		turnGate: new FifoGate(1),
		pendingTurns: 0,
		lastUsedAt: 0,
	};
}

describe("subagent FIFO gate", () => {
	it("admits four calls and grants later calls in order", async () => {
		const gate = new FifoGate(4);
		const controllers = Array.from({ length: 6 }, () => new AbortController());
		const releases = await Promise.all(controllers.slice(0, 4).map((controller) => gate.acquire(controller.signal)));
		const order: number[] = [];
		const fifth = gate.acquire(controllers[4].signal).then((release) => {
			order.push(5);
			return release;
		});
		const sixth = gate.acquire(controllers[5].signal).then((release) => {
			order.push(6);
			return release;
		});

		releases[0]();
		const releaseFifth = await fifth;
		expect(order).toEqual([5]);
		releases[1]();
		const releaseSixth = await sixth;
		expect(order).toEqual([5, 6]);

		for (const release of [...releases.slice(2), releaseFifth, releaseSixth]) release();
	});

	it("removes an aborted waiter without consuming capacity", async () => {
		const gate = new FifoGate(1);
		const active = new AbortController();
		const release = await gate.acquire(active.signal);
		const waiting = new AbortController();
		const rejected = gate.acquire(waiting.signal);
		waiting.abort();
		await expect(rejected).rejects.toThrow("aborted while waiting");
		release();

		const nextRelease = await gate.acquire(new AbortController().signal);
		nextRelease();
	});
});

describe("cappedTail", () => {
	it("keeps the latest characters past the preview limit", () => {
		const text = `${"HEAD_MARKER_"}${"a".repeat(500)}TAIL_MARKER_${"b".repeat(200)}`;
		const preview = cappedTail(text, 600);
		expect(preview.startsWith("…")).toBe(true);
		expect(preview).toContain("TAIL_MARKER_");
		expect(preview).not.toContain("HEAD_MARKER_");
	});
});

describe("runSubagentTurn", () => {
	it("continues the same child session without repeating bootstrap instructions", async () => {
		const session = fakeSession({
			responses: [assistant("first result", 10), assistant("follow-up result", 20)],
		});
		const prompts: string[] = [];
		const original = session.prompt.bind(session);
		session.prompt = async (text: string) => {
			prompts.push(text);
			return original(text);
		};
		const thread = threadOf(session);

		const first = await runSubagentTurn({
			thread,
			task: "Inspect config",
			initial: true,
			signal: new AbortController().signal,
		});
		const second = await runSubagentTurn({
			thread,
			task: "Check the proposed fix",
			initial: false,
			signal: new AbortController().signal,
		});

		expect(prompts[0]).toContain("## Agent instructions\nInspect only requested files.");
		expect(prompts[1]).not.toContain("## Agent instructions");
		expect(prompts[1]).toContain("## Parent follow-up\nCheck the proposed fix");
		expect(first.content).toBe("first result");
		expect(second.content).toBe("follow-up result");
		expect(first.details.usage.input).toBe(10);
		expect(second.details.usage.input).toBe(20);
		expect(first.retainable).toBe(true);
		expect(second.retainable).toBe(true);
		expect(thread.turns).toBe(2);
	});

	it("never starts a prompt when the signal is already aborted", async () => {
		let prompted = false;
		const session = fakeSession({
			onPrompt: () => {
				prompted = true;
			},
		});
		const controller = new AbortController();
		controller.abort();
		const result = await runSubagentTurn({
			thread: threadOf(session),
			task: "nope",
			initial: true,
			signal: controller.signal,
		});
		expect(prompted).toBe(false);
		expect(result.details.status).toBe("aborted");
		expect(result.retainable).toBe(false);
	});

	it("does not create an unhandled rejection when session.abort rejects", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			const session = fakeSession({
				abortImpl: async () => {
					throw new Error("abort failed");
				},
			});
			const controller = new AbortController();
			const turn = runSubagentTurn({
				thread: threadOf(session),
				task: "work",
				initial: true,
				signal: controller.signal,
			});
			// Abort during prompt path after subscribe is installed.
			controller.abort();
			await turn;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	it("streams a changing rolling tail for long responses", async () => {
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const session = {
			isStreaming: false,
			subscribe(listener: (event: AgentSessionEvent) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async prompt() {
				const chunks = [`${"x".repeat(700)}ONE`, `${"y".repeat(700)}TWO`];
				for (const text of chunks) {
					now += 150;
					const message = assistant(text);
					for (const listener of listeners) {
						listener({
							type: "message_update",
							message,
							assistantMessageEvent: { type: "text_delta", delta: "" },
						} as AgentSessionEvent);
					}
				}
				now += 150;
				const terminal = assistant(`${"z".repeat(700)}DONE`);
				for (const listener of listeners) listener({ type: "message_end", message: terminal });
			},
			async abort() {},
			dispose() {},
		} as unknown as AgentSession;
		const previews: string[] = [];
		try {
			await runSubagentTurn({
				thread: threadOf(session),
				task: "stream",
				initial: true,
				signal: new AbortController().signal,
				onUpdate: (details) => {
					if (details.response) previews.push(details.response);
				},
			});
		} finally {
			vi.restoreAllMocks();
		}
		expect(previews.some((item) => item.includes("ONE"))).toBe(true);
		expect(previews.some((item) => item.includes("TWO"))).toBe(true);
		expect(previews.at(-1)).toContain("DONE");
		expect(previews.every((item) => item.includes("ONE"))).toBe(false);
	});

	it("marks prompt failures as not retainable", async () => {
		const session = fakeSession({
			onPrompt: async () => {
				throw new Error("session broken");
			},
		});
		// Override prompt to throw before emitting messages
		session.prompt = async () => {
			throw new Error("session broken");
		};
		const result = await runSubagentTurn({
			thread: threadOf(session),
			task: "x",
			initial: true,
			signal: new AbortController().signal,
		});
		expect(result.details.status).toBe("failed");
		expect(result.retainable).toBe(false);
	});
});

// silence unused import when vitest tree-shakes
void vi;
