import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Context,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../../extensions/subagent/agents.ts";
import { SubagentRuntime } from "../../../extensions/subagent/runtime.ts";

const OLD_PRIOR_FILE_SENTINEL = "OLD_PRIOR_FILE_SENTINEL_validation";
const OLD_CURRENT_FILE_SENTINEL = "OLD_CURRENT_FILE_SENTINEL_validation";
const CURRENT_PRIOR_FILE_SENTINEL = "CURRENT_PRIOR_FILE_SENTINEL_validation";
const CURRENT_CALL_AUTOREAD_SENTINEL = "CURRENT_CALL_AUTOREAD_SENTINEL_validation";
const OLD_TOOL_RESULT_SENTINEL = "OLD_TOOL_RESULT_SENTINEL_validation";
const OLD_INTERMEDIATE_RESPONSE_SENTINEL = "OLD_INTERMEDIATE_RESPONSE_SENTINEL_validation";
const OLD_REASONING_SENTINEL = "OLD_REASONING_SENTINEL_validation";
const INITIAL_TERMINAL_RESULT_SENTINEL = "INITIAL_TERMINAL_RESULT_SENTINEL_validation";
const HOT_FOLLOWUP_RESULT_SENTINEL = "HOT_FOLLOWUP_RESULT_SENTINEL_validation";

const definition: AgentDefinition = {
	name: "resume-validation",
	description: "Deterministic resume validation",
	tools: ["read"],
	names: ["Verifier"],
	prompt: "RESUME_VALIDATION_AGENT_DEFINITION_SENTINEL",
	path: "/agents/resume-validation.md",
};

function textOfToolResult(message: ToolResultMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function captureRequest(requests: Context[], context: Context): void {
	requests.push(JSON.parse(JSON.stringify(context)) as Context);
}

describe("cold subagent request integration", () => {
	it("uses the real runtime and AgentSession while excluding the hot transcript from a cold request", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-subagent-resume-validation-"));
		const requests: Context[] = [];
		const faux = fauxProvider({
			provider: "tau-resume-validation",
			api: "tau-resume-validation-api",
			models: [{ id: "deterministic", name: "Deterministic", reasoning: true }],
			tokensPerSecond: 1_000_000,
		});
		faux.setResponses([
			(context) => {
				captureRequest(requests, context);
				return fauxAssistantMessage(
					[
						fauxThinking(OLD_REASONING_SENTINEL),
						fauxText(OLD_INTERMEDIATE_RESPONSE_SENTINEL),
						fauxToolCall("read", { path: "tool-result.txt" }, { id: "old-tool-call" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				captureRequest(requests, context);
				return fauxAssistantMessage(INITIAL_TERMINAL_RESULT_SENTINEL);
			},
			(context) => {
				captureRequest(requests, context);
				return fauxAssistantMessage(HOT_FOLLOWUP_RESULT_SENTINEL);
			},
			(context) => {
				captureRequest(requests, context);
				return fauxAssistantMessage(
					[
						fauxToolCall("read", { path: "prior.txt" }, { id: "cold-prior-read" }),
						fauxToolCall("read", { path: "current.txt" }, { id: "cold-current-read" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				captureRequest(requests, context);
				return fauxAssistantMessage("cold complete");
			},
		]);
		const model = faux.getModel();
		const ctx = {
			cwd,
			mode: "print",
			hasUI: false,
			model,
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === model.provider && id === model.id ? model : undefined,
				getProvider: (provider: string) => (provider === model.provider ? faux.provider : undefined),
				getApiKeyAndHeaders: async () => ({ ok: true as const }),
				isUsingOAuth: () => false,
			},
			ui: { notify() {} },
		} as unknown as ExtensionContext;
		const extensionPath = join(import.meta.dirname, "../../../extensions/explore/index.ts");
		const pi = {
			getAllTools: () => [{ name: "read", sourceInfo: { path: extensionPath } }],
		} as unknown as ExtensionAPI;
		let now = Date.now();
		const runtime = new SubagentRuntime(pi, { now: () => now });
		const freshOptions = {
			agent: definition.name,
			task: "INITIAL_TASK_SENTINEL",
			files: ["prior.txt", "current.txt"],
			continuing: false,
			definition,
			ctx,
			parentModel: `${model.provider}/${model.id}`,
			parentThinking: "medium",
			resolveFreshDefinition: async () => ({ ok: true as const, definition }),
		};
		try {
			await writeFile(join(cwd, "prior.txt"), `${OLD_PRIOR_FILE_SENTINEL}\nprior old`, "utf8");
			await writeFile(join(cwd, "current.txt"), `${OLD_CURRENT_FILE_SENTINEL}\ncurrent old`, "utf8");
			await writeFile(join(cwd, "tool-result.txt"), OLD_TOOL_RESULT_SENTINEL, "utf8");
			const initial = await runtime.execute(freshOptions);
			expect(initial.details.status).toBe("completed");
			expect(initial.details.response).toBe(INITIAL_TERMINAL_RESULT_SENTINEL);
			const threadId = initial.details.threadId;
			if (!threadId) throw new Error("initial thread missing");
			const initialThread = runtime.listThreads(cwd)[0];
			const hotResource = initialThread?.resource;
			if (!hotResource || !initialThread.lastAssistantMessageAt) throw new Error("hot resource timestamp missing");
			now = initialThread.lastAssistantMessageAt + 299_999;
			const hot = await runtime.execute({
				...freshOptions,
				agent: threadId,
				task: "HOT_TASK_SENTINEL",
				files: [],
				continuing: true,
				threadKey: threadId,
			});
			expect(hot.details.response).toBe(HOT_FOLLOWUP_RESULT_SENTINEL);
			expect(runtime.listThreads(cwd)[0]?.resource).toBe(hotResource);
			const hotRequest = JSON.stringify(requests[2]);
			for (const expected of [
				OLD_PRIOR_FILE_SENTINEL,
				OLD_CURRENT_FILE_SENTINEL,
				OLD_TOOL_RESULT_SENTINEL,
				"old-tool-call",
				OLD_INTERMEDIATE_RESPONSE_SENTINEL,
				OLD_REASONING_SENTINEL,
				INITIAL_TERMINAL_RESULT_SENTINEL,
			])
				expect(hotRequest).toContain(expected);

			await writeFile(join(cwd, "prior.txt"), CURRENT_PRIOR_FILE_SENTINEL, "utf8");
			await writeFile(join(cwd, "current.txt"), CURRENT_CALL_AUTOREAD_SENTINEL, "utf8");
			const retained = runtime.listThreads(cwd)[0];
			if (!retained?.lastAssistantMessageAt) throw new Error("hot assistant timestamp missing");
			now = retained.lastAssistantMessageAt + 300_000;
			const followUp = "COLD_PARENT_FOLLOWUP_SENTINEL";
			const cold = await runtime.execute({
				...freshOptions,
				agent: threadId,
				task: followUp,
				files: ["current.txt"],
				continuing: true,
				threadKey: threadId,
			});
			expect(cold.details.status).toBe("completed");
			expect(requests).toHaveLength(5);
			const replacement = runtime.listThreads(cwd)[0];
			if (!replacement) throw new Error("replacement thread missing");
			expect(replacement.resource).not.toBe(hotResource);
			expect(replacement.id).toBe(threadId);
			expect(replacement.displayName).toBe(initial.details.displayName);
			expect(replacement.model).toBe(initial.details.model);
			expect(replacement.thinkingLevel).toBe(initial.details.thinkingLevel);
			expect(replacement.definition.tools).toEqual(definition.tools);
			expect(replacement.cwd).toBe(cwd);

			const coldFirst = requests[3];
			if (!coldFirst) throw new Error("cold provider request missing");
			const coldPayload = JSON.stringify(coldFirst);
			for (const expected of [
				INITIAL_TERMINAL_RESULT_SENTINEL,
				HOT_FOLLOWUP_RESULT_SENTINEL,
				"prior.txt",
				"current.txt",
				followUp,
				CURRENT_CALL_AUTOREAD_SENTINEL,
			])
				expect(coldPayload).toContain(expected);
			for (const forbidden of [
				OLD_PRIOR_FILE_SENTINEL,
				OLD_CURRENT_FILE_SENTINEL,
				OLD_TOOL_RESULT_SENTINEL,
				"old-tool-call",
				OLD_INTERMEDIATE_RESPONSE_SENTINEL,
				OLD_REASONING_SENTINEL,
			])
				expect(coldPayload).not.toContain(forbidden);
			expect(coldFirst.messages.filter((message) => message.role === "assistant")).toEqual([]);
			expect(coldFirst.messages.filter((message) => message.role === "toolResult")).toEqual([]);
			expect(occurrences(coldPayload, definition.prompt)).toBe(1);

			const coldAfterReads = requests[4];
			if (!coldAfterReads) throw new Error("cold tool-result request missing");
			const toolResults = coldAfterReads.messages.filter(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			const priorResult = toolResults.find((message) => message.toolCallId === "cold-prior-read");
			const currentResult = toolResults.find((message) => message.toolCallId === "cold-current-read");
			if (!priorResult || !currentResult) throw new Error("cold read results missing");
			expect(textOfToolResult(priorResult)).toBe(CURRENT_PRIOR_FILE_SENTINEL);
			expect(textOfToolResult(currentResult)).toBe("unchanged, 1 lines");
			expect(priorResult.details).toMatchObject({ readCache: { mode: "baseline" } });
			expect(currentResult.details).toMatchObject({ readCache: { mode: "unchanged" } });
		} finally {
			await runtime.shutdown();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
