import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FifoGate, runSubagentTurn, type SubagentThread } from "../../../extensions/subagent/run.ts";

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

	it("continues the same child session without repeating bootstrap instructions", async () => {
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const prompts: string[] = [];
		const response = (text: string, input: number): AssistantMessage => ({
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
			stopReason: "stop",
			timestamp: 0,
		});
		const responses = [response("first result", 10), response("follow-up result", 20)];
		let responseIndex = 0;
		const session = {
			isStreaming: false,
			subscribe(listener: (event: AgentSessionEvent) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async prompt(text: string) {
				prompts.push(text);
				const message = responses[responseIndex++];
				if (!message) throw new Error("missing test response");
				for (const listener of listeners) listener({ type: "message_end", message });
			},
			async abort() {},
			dispose() {},
		} as unknown as AgentSession;
		const thread: SubagentThread = {
			id: "thread-1",
			definition: {
				name: "scout",
				description: "Scout",
				tools: ["read"],
				prompt: "Inspect only requested files.",
				path: "/agents/scout.md",
			},
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
		expect(thread.turns).toBe(2);
	});
});
