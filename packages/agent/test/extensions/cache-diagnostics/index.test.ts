import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => testState.agentDir,
}));

import cacheDiagnosticsExtension from "../../../extensions/cache-diagnostics/index.ts";

type Handler = (...args: never[]) => unknown;

interface RegisteredCommand {
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

function assistantUsage(input: number, cacheRead: number, cacheWrite: number, stopReason = "stop") {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-test",
		stopReason,
		usage: { input, cacheRead, cacheWrite },
	};
}

async function harness(reuseAgentDirectory = false) {
	if (!reuseAgentDirectory) testState.agentDir = await mkdtemp(join(tmpdir(), "tau-cache-diagnostics-"));
	const handlers = new Map<string, Handler[]>();
	let command: RegisteredCommand | undefined;
	const notifications: string[] = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(_name: string, registered: RegisteredCommand) {
			command = registered;
		},
	} as unknown as ExtensionAPI;
	cacheDiagnosticsExtension(pi);
	const ctx = {
		cwd: "/work/project",
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/sessions/session-1.jsonl",
		},
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
	const run = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event as never, ctx as never);
	};
	await run("session_start", { type: "session_start", reason: "startup" });
	return { command, ctx, notifications, run };
}

afterEach(async () => {
	if (testState.agentDir) await rm(testState.agentDir, { recursive: true, force: true });
	testState.agentDir = "";
});

describe("cache diagnostics extension", () => {
	it("writes a bounded report containing a stable-prefix cache miss", async () => {
		const test = await harness();
		const payload = {
			model: "claude-test",
			system: "private prompt",
			tools: [{ name: "read", description: "Read files" }],
			messages: [{ role: "user", content: "private request" }],
		};
		await test.run("before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "private prompt",
			systemPromptOptions: { cwd: "/work/project", selectedTools: ["read"] },
		});
		await test.run("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
		await test.run("before_provider_request", { type: "before_provider_request", payload });
		await test.run("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
		await test.run("message_end", { type: "message_end", message: assistantUsage(0, 0, 5_000) });

		await test.run("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
		await test.run("before_provider_request", {
			type: "before_provider_request",
			payload: { ...payload, messages: [...payload.messages, { role: "user", content: "next" }] },
		});
		await test.run("after_provider_response", {
			type: "after_provider_response",
			status: 200,
			headers: { "request-id": "req-2" },
		});
		await test.run("message_end", { type: "message_end", message: assistantUsage(5_000, 0, 0) });

		expect(test.command).toBeDefined();
		await test.command?.handler("", test.ctx as ExtensionCommandContext);
		const reportDirectory = join(testState.agentDir, "cache-diagnostics", "reports");
		const reportFiles = await readdir(reportDirectory);
		expect(reportFiles).toHaveLength(1);
		const report = JSON.parse(await readFile(join(reportDirectory, reportFiles[0] ?? ""), "utf8")) as {
			cwd: string;
			summary: { cacheMissesObserved: number };
			requests: Array<{ previousExactPrefix: boolean; changes: { firstChangedItem: number | null } }>;
			results: Array<{ cacheMiss: boolean; missedTokens: number }>;
		};
		expect(report.cwd).toBe("/work/project");
		expect(report.summary.cacheMissesObserved).toBe(1);
		expect(report.requests.at(-1)).toMatchObject({
			previousExactPrefix: true,
			changes: { firstChangedItem: 1 },
		});
		expect(report.results.at(-1)).toMatchObject({ cacheMiss: true, missedTokens: 5_000 });
		expect(test.notifications[0]).toContain("Cache debug written:");
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("private prompt");
		expect(serialized).not.toContain("private request");
	});

	it("pairs an assistant result with a retry when the failed attempt had no response", async () => {
		const test = await harness();
		await test.run("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
		await test.run("before_provider_request", { type: "before_provider_request", payload: { messages: [] } });
		await test.run("before_provider_request", { type: "before_provider_request", payload: { messages: [] } });
		await test.run("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
		await test.run("message_end", { type: "message_end", message: assistantUsage(10, 0, 0) });
		await test.command?.handler("", test.ctx as ExtensionCommandContext);
		const reportDirectory = join(testState.agentDir, "cache-diagnostics", "reports");
		const reportFile = (await readdir(reportDirectory))[0] ?? "";
		const report = JSON.parse(await readFile(join(reportDirectory, reportFile), "utf8")) as {
			responses: Array<{ id: string; status: number }>;
			results: Array<{ id: string }>;
		};
		expect(report.responses.map((response) => response.status)).toEqual([200]);
		expect(report.results[0]?.id).toBe(report.responses[0]?.id);
	});

	it("does not replace a valid cache baseline with a failed turn", async () => {
		const test = await harness();
		const payload = { model: "claude-test", messages: [{ role: "user", content: "one" }] };
		await test.run("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
		await test.run("before_provider_request", { type: "before_provider_request", payload });
		await test.run("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
		await test.run("message_end", { type: "message_end", message: assistantUsage(0, 0, 5_000) });

		await test.run("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
		await test.run("before_provider_request", { type: "before_provider_request", payload });
		await test.run("after_provider_response", { type: "after_provider_response", status: 500, headers: {} });
		await test.run("message_end", { type: "message_end", message: assistantUsage(0, 0, 0, "error") });

		await test.run("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 3 });
		await test.run("before_provider_request", { type: "before_provider_request", payload });
		await test.run("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
		await test.run("message_end", { type: "message_end", message: assistantUsage(5_000, 0, 0) });
		await test.command?.handler("", test.ctx as ExtensionCommandContext);
		const reportDirectory = join(testState.agentDir, "cache-diagnostics", "reports");
		const reportFile = (await readdir(reportDirectory))[0] ?? "";
		const report = JSON.parse(await readFile(join(reportDirectory, reportFile), "utf8")) as {
			results: Array<{ cacheMiss: boolean; baselinePromoted: boolean }>;
		};
		expect(report.results.map((result) => result.baselinePromoted)).toEqual([true, false, true]);
		expect(report.results.at(-1)?.cacheMiss).toBe(true);
	});

	it("includes diagnostics recorded before the extension runtime reloaded", async () => {
		const first = await harness();
		await first.run("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
		await first.run("before_provider_request", {
			type: "before_provider_request",
			payload: { model: "claude-test", messages: [] },
		});
		await first.run("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
		await first.run("message_end", { type: "message_end", message: assistantUsage(0, 0, 2_000) });

		const reloaded = await harness(true);
		await reloaded.command?.handler("", reloaded.ctx as ExtensionCommandContext);
		const reportDirectory = join(testState.agentDir, "cache-diagnostics", "reports");
		const reportFile = (await readdir(reportDirectory))[0] ?? "";
		const report = JSON.parse(await readFile(join(reportDirectory, reportFile), "utf8")) as {
			summary: { requestsObserved: number; resultsObserved: number };
		};
		expect(report.summary).toMatchObject({ requestsObserved: 1, resultsObserved: 1 });
	});

	it("does not restore cache activity from before a model switch", async () => {
		const first = await harness();
		await first.run("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
		await first.run("before_provider_request", {
			type: "before_provider_request",
			payload: { model: "model-a", messages: [] },
		});
		await first.run("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
		await first.run("message_end", { type: "message_end", message: assistantUsage(0, 0, 2_000) });
		await first.run("model_select", {
			type: "model_select",
			model: { provider: "anthropic", id: "model-b" },
			previousModel: { provider: "anthropic", id: "model-a" },
			source: "set",
		});
		await first.run("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
		await first.run("before_provider_request", {
			type: "before_provider_request",
			payload: { model: "model-b", messages: [] },
		});
		await first.run("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
		await first.run("message_end", { type: "message_end", message: assistantUsage(2_000, 0, 0) });

		const reloaded = await harness(true);
		await reloaded.run("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 3 });
		await reloaded.run("before_provider_request", {
			type: "before_provider_request",
			payload: { model: "model-b", messages: [] },
		});
		await reloaded.run("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
		await reloaded.run("message_end", { type: "message_end", message: assistantUsage(2_000, 0, 0) });
		await reloaded.command?.handler("", reloaded.ctx as ExtensionCommandContext);
		const reportDirectory = join(testState.agentDir, "cache-diagnostics", "reports");
		const reportFile = (await readdir(reportDirectory))[0] ?? "";
		const report = JSON.parse(await readFile(join(reportDirectory, reportFile), "utf8")) as {
			results: Array<{ cacheMiss: boolean }>;
		};
		expect(report.results.at(-1)?.cacheMiss).toBe(false);
	});
});
