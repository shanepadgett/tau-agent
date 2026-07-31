import {
	fauxAssistantMessage,
	fauxToolCall,
	Type,
	type Context,
	type Model,
	type Tool,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertResponsesMessages, convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
	convertMessages as convertGoogleMessages,
	convertTools as convertGoogleTools,
} from "@earendil-works/pi-ai/api/google-shared";
import { convertToLlm, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectSessionMemory } from "../../../extensions/session-memory/projection.ts";
import {
	formatSessionMemory,
	replaySessionMemory,
	sessionMemoryParameters,
	type SessionMemoryDetailsV2,
	type SessionMemoryInput,
	type SessionMemoryState,
} from "../../../extensions/session-memory/state.ts";

type ContextMessage = ContextEvent["messages"][number];

interface NativePayload {
	system: unknown;
	tools: unknown;
	sequence: readonly unknown[];
}

const system = "stable system prompt";
const state: SessionMemoryState = {
	longTermGoal: "Ship cache-stable session memory",
	tasks: ["Preserve longest stable prefix"],
	shortTermMemories: [],
	longTermMemories: [{ id: "cache-stability", text: "Only checkpoints may replace message history." }],
	readFiles: [],
	outlineFiles: [],
	deferFiles: [],
};
const updateInput: Extract<SessionMemoryInput, { action: "update" }> = {
	action: "update",
	longTermGoal: state.longTermGoal,
	tasks: state.tasks,
	shortTermMemories: [],
	longTermMemories: state.longTermMemories,
	readFiles: [],
	outlineFiles: [],
	deferFiles: [],
};
const tools: Tool[] = [
	{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
	{ name: "session_memory", description: "Update or checkpoint session memory", parameters: sessionMemoryParameters },
];

const anthropicModel = {
	id: "claude-sonnet-4-6",
	name: "Claude fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_000,
} satisfies Model<"anthropic-messages">;

const openAiModel = {
	...anthropicModel,
	id: "gpt-5.4",
	name: "OpenAI fixture",
	api: "openai-responses",
	provider: "openai",
} satisfies Model<"openai-responses">;

const googleModel = {
	...anthropicModel,
	id: "gemini-3-pro",
	name: "Google fixture",
	api: "google-generative-ai",
	provider: "google",
} satisfies Model<"google-generative-ai">;

function details(
	toolCallId: string,
	kind: "update" | "checkpoint",
	checkpoint: number,
	task: string,
): SessionMemoryDetailsV2 {
	return {
		v: 2,
		toolCallId,
		kind,
		checkpoint,
		state: { ...state, tasks: [task] },
		changes: ["Fixture created"],
		outlinedRows: [],
		prunedRowIds: [],
		warnings: [],
	};
}

function call(id: string, input: SessionMemoryInput): ContextMessage {
	return fauxAssistantMessage(fauxToolCall("session_memory", input, { id }));
}

function result(id: string, value: SessionMemoryDetailsV2): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "session_memory",
		content: [{ type: "text", text: formatSessionMemory(value.state, value.checkpoint, value.warnings) }],
		details: value,
		isError: false,
		timestamp: 1,
	};
}

function readResult(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: `result ${id}` }],
		isError: false,
		timestamp: 1,
	};
}

function entry(id: string, message: ContextMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-29T12:00:00.000Z",
		message,
	};
}

function project(messages: ContextMessage[], branch: SessionEntry[]): ContextMessage[] {
	return projectSessionMemory(messages, replaySessionMemory(branch)).messages;
}

function openAiPayload(messages: ContextMessage[]): NativePayload {
	const context: Context = { systemPrompt: system, messages: convertToLlm(messages), tools };
	return {
		system,
		tools: convertResponsesTools(tools),
		sequence: convertResponsesMessages(openAiModel, context, new Set(["openai"]), { includeSystemPrompt: false }),
	};
}

function googlePayload(messages: ContextMessage[]): NativePayload {
	return {
		system: { parts: [{ text: system }] },
		tools: convertGoogleTools(tools),
		sequence: convertGoogleMessages(googleModel, { systemPrompt: system, messages: convertToLlm(messages), tools }),
	};
}

async function anthropicPayload(messages: ContextMessage[]): Promise<NativePayload> {
	let payload: unknown;
	const body = [
		'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","usage":{"input_tokens":1,"output_tokens":0}}}',
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
		'event: message_stop\ndata: {"type":"message_stop"}',
		"",
	].join("\n\n");
	const client = {
		messages: {
			create: () => ({
				asResponse: async () =>
					new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
			}),
		},
	};
	const stream = streamAnthropic(
		anthropicModel,
		{ systemPrompt: system, messages: convertToLlm(messages), tools },
		{
			client: client as never,
			cacheRetention: "none",
			onPayload(value) {
				payload = value;
			},
		},
	);
	for await (const event of stream) {
		// Consume fixture response so payload capture completes.
		expect(event).toBeDefined();
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		throw new Error("Anthropic payload was not captured");
	const value = payload as Record<string, unknown>;
	if (!Array.isArray(value.messages)) throw new Error("Anthropic payload did not contain messages");
	return { system: value.system, tools: value.tools, sequence: value.messages };
}

function expectAppendOnly(previous: NativePayload, next: NativePayload): void {
	expect(next.system).toEqual(previous.system);
	expect(next.tools).toEqual(previous.tools);
	expect(next.sequence.slice(0, previous.sequence.length)).toEqual(previous.sequence);
}

describe("session-memory provider cache stability", () => {
	it.each([
		["Anthropic", anthropicPayload],
		["OpenAI", async (messages: ContextMessage[]) => openAiPayload(messages)],
		["Google", async (messages: ContextMessage[]) => googlePayload(messages)],
	] as const)("appends the %s cadence reminder only at the request tail", async (_provider, serialize) => {
		const messages: ContextMessage[] = [];
		const branch: SessionEntry[] = [];
		for (let index = 0; index < 10; index += 1) {
			const id = `read-${index}`;
			const toolCall = fauxAssistantMessage(fauxToolCall("read", { path: `${index}.ts` }, { id }));
			const toolResult = readResult(id);
			messages.push(toolCall, toolResult);
			branch.push(entry(`${id}-call`, toolCall), entry(`${id}-result`, toolResult));
		}

		const beforeReminder = project(messages.slice(0, -2), branch.slice(0, -2));
		const withReminder = project(messages, branch);
		expect(withReminder.at(-1)).toMatchObject({
			role: "custom",
			customType: "tau.session-memory.task-reminder",
		});

		const beforePayload = await serialize(beforeReminder);
		const reminderPayload = await serialize(withReminder);
		const repeatedPayload = await serialize(project(messages, branch));
		expectAppendOnly(beforePayload, reminderPayload);
		expect(repeatedPayload).toEqual(reminderPayload);
	});

	it.each([
		["Anthropic", anthropicPayload],
		["OpenAI", async (messages: ContextMessage[]) => openAiPayload(messages)],
		["Google", async (messages: ContextMessage[]) => googlePayload(messages)],
	] as const)(
		"keeps %s native payload append-only between one-time checkpoint replacements",
		async (_provider, serialize) => {
			const checkpoint1 = details("checkpoint-1", "checkpoint", 1, "Checkpoint one");
			const update1 = details("update-1", "update", 1, "Ordinary update one");
			const update2 = details("update-2", "update", 1, "Ordinary update two");
			const checkpoint2 = details("checkpoint-2", "checkpoint", 2, "Checkpoint two");
			const checkpoint1Call = call("checkpoint-1", { action: "checkpoint" });
			const checkpoint1Result = result("checkpoint-1", checkpoint1);
			const update1Call = call("update-1", { ...updateInput, tasks: ["Ordinary update one"] });
			const update1Result = result("update-1", update1);
			const update2Call = call("update-2", { ...updateInput, tasks: ["Ordinary update two"] });
			const update2Result = result("update-2", update2);
			const required: ContextMessage = {
				role: "custom",
				customType: "tau.session-memory.instruction",
				content: "Checkpoint required. Reconcile session memory with action update before using other tools.",
				display: false,
				timestamp: 1,
			};
			const checkpoint2Call = call("checkpoint-2", { ...updateInput, tasks: ["Checkpoint two"] });
			const checkpoint2Result = result("checkpoint-2", checkpoint2);
			const old: ContextMessage = { role: "user", content: "old context", timestamp: 1 };
			const branch1 = [entry("checkpoint-1-call", checkpoint1Call), entry("checkpoint-1-result", checkpoint1Result)];
			const branchWithUpdates = [
				...branch1,
				entry("update-1-call", update1Call),
				entry("update-1-result", update1Result),
				entry("update-2-call", update2Call),
				entry("update-2-result", update2Result),
			];
			const checkpoint1Messages = project([old, checkpoint1Call, checkpoint1Result], branch1);
			const ordinary1Messages = project(
				[old, checkpoint1Call, checkpoint1Result, update1Call, update1Result],
				branchWithUpdates.slice(0, 4),
			);
			const ordinary2Messages = project(
				[old, checkpoint1Call, checkpoint1Result, update1Call, update1Result, update2Call, update2Result],
				branchWithUpdates,
			);
			const requiredMessages = [...ordinary2Messages, required];

			const checkpoint1Payload = await serialize(checkpoint1Messages);
			const ordinary1Payload = await serialize(ordinary1Messages);
			const ordinary2Payload = await serialize(ordinary2Messages);
			const requiredPayload = await serialize(requiredMessages);
			expectAppendOnly(checkpoint1Payload, ordinary1Payload);
			expectAppendOnly(ordinary1Payload, ordinary2Payload);
			expectAppendOnly(ordinary2Payload, requiredPayload);

			const branch2 = [
				...branchWithUpdates,
				entry("checkpoint-2-call", checkpoint2Call),
				entry("checkpoint-2-result", checkpoint2Result),
			];
			const checkpoint2Messages = project(
				[
					old,
					checkpoint1Call,
					checkpoint1Result,
					update1Call,
					update1Result,
					update2Call,
					update2Result,
					required,
					checkpoint2Call,
					checkpoint2Result,
				],
				branch2,
			);
			const checkpoint2Payload = await serialize(checkpoint2Messages);
			expect(checkpoint2Payload.system).toEqual(requiredPayload.system);
			expect(checkpoint2Payload.tools).toEqual(requiredPayload.tools);
			expect(checkpoint2Payload.sequence).not.toEqual(requiredPayload.sequence);

			const fileInjection: ContextMessage = {
				role: "custom",
				customType: "tau.file",
				content: "active.ts\nconst current = true;",
				display: true,
				timestamp: 2,
			};
			const firstPostCheckpointPayload = await serialize([...checkpoint2Messages, fileInjection]);
			const nextUpdateCall = call("update-3", { ...updateInput, tasks: ["After checkpoint"] });
			const nextUpdate = details("update-3", "update", 2, "After checkpoint");
			const nextPostCheckpointPayload = await serialize([
				...checkpoint2Messages,
				fileInjection,
				nextUpdateCall,
				result("update-3", nextUpdate),
			]);
			expectAppendOnly(checkpoint2Payload, firstPostCheckpointPayload);
			expectAppendOnly(firstPostCheckpointPayload, nextPostCheckpointPayload);
		},
	);
});
