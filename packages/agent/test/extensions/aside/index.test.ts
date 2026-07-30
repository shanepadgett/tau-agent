import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import asideExtension, { buildAsideRequest } from "../../../extensions/aside/index.ts";

interface RegisteredCommand {
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

function user(text: string, timestamp = 1): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(content: AssistantMessage["content"], timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function harness(contextChoice = "Current conversation branch") {
	let command: RegisteredCommand | undefined;
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>>>();
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const setWidget = vi.fn();
	const custom = vi.fn(async (factory: (...args: unknown[]) => unknown) => {
		factory(
			{ terminal: { rows: 40 }, requestRender() {} },
			{ fg: (_name: string, text: string) => text, bold: (text: string) => text },
			{ matches: () => false },
			() => {},
		);
	});
	const response = deferred<AssistantMessage>();
	const streamSimple = vi.fn((_model: Model<string>, _request: Context, _options?: SimpleStreamOptions) => ({
		result: () => response.promise,
	}));
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(_name: string, registered: RegisteredCommand) {
			command = registered;
		},
	} as unknown as ExtensionAPI;
	asideExtension(pi);

	const model = {
		id: "test-model",
		name: "Test model",
		api: "test",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_000,
	} as Model<string>;
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-07-29T10:00:00.000Z",
			message: user("Parent request"),
		},
	];
	const ctx = {
		mode: "tui",
		model,
		thinkingLevel: "medium",
		modelRegistry: {
			getProvider: () => ({ streamSimple }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: { "x-test": "yes" } }),
		},
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => "user-1",
			getSessionId: () => "parent-session",
		},
		getSystemPrompt: () => "Parent system prompt",
		ui: {
			select: async () => contextChoice,
			setWidget,
			custom,
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	} as unknown as ExtensionCommandContext;

	return { command, ctx, handlers, notifications, response, setWidget, streamSimple, custom };
}

beforeEach(() => vi.restoreAllMocks());

describe("aside request", () => {
	it("keeps consecutive conversation requests cache-stable through the final question", () => {
		const messages = [user("First"), assistant([{ type: "text", text: "Answer" }])];
		const first = buildAsideRequest(messages, "Side question one", "Stable system prompt");
		const second = buildAsideRequest(messages, "Side question two", "Stable system prompt");

		expect(first.systemPrompt).toBe(second.systemPrompt);
		expect(first.messages.slice(0, -1)).toEqual(second.messages.slice(0, -1));
		expect(first.messages.slice(0, -1)).toEqual(messages);
		expect(messages).toHaveLength(2);
		expect(first.messages.at(-1)).not.toEqual(second.messages.at(-1));
	});

	it("drops an in-flight assistant tool-call suffix before appending the question", () => {
		const messages: Message[] = [
			user("Run tools"),
			assistant([
				{ type: "toolCall", id: "done", name: "read", arguments: {} },
				{ type: "toolCall", id: "pending", name: "bash", arguments: {} },
			]),
			{
				role: "toolResult",
				toolCallId: "done",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 3,
			},
		];

		const request = buildAsideRequest(messages, "What is happening?", "system");
		expect(request.messages).toEqual([user("Run tools"), user("What is happening?", expect.any(Number) as number)]);
	});
});

describe("aside extension", () => {
	it("shows a thinking widget, then clears it and opens the completed answer", async () => {
		const test = harness();
		expect(test.command).toBeDefined();

		await test.command?.handler("Why?", test.ctx);
		await vi.waitFor(() => expect(test.streamSimple).toHaveBeenCalledOnce());
		const [_model, request, options] = test.streamSimple.mock.calls[0] ?? [];
		expect(request).toMatchObject({
			systemPrompt: "Parent system prompt",
			messages: [
				{ role: "user", content: [{ type: "text", text: "Parent request" }] },
				{ role: "user", content: [{ type: "text", text: "Why?" }] },
			],
		});
		expect(request).not.toHaveProperty("tools");
		expect(options).toMatchObject({ apiKey: "secret", reasoning: "medium", sessionId: "parent-session" });

		await test.command?.handler("Another question", test.ctx);
		expect(test.streamSimple).toHaveBeenCalledOnce();
		expect(test.notifications.at(-1)).toMatchObject({ message: "An aside is already running", type: "warning" });

		test.response.resolve(assistant([{ type: "text", text: "Side answer" }]));
		await vi.waitFor(() => expect(test.setWidget).toHaveBeenCalledTimes(2));
		expect(test.setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
		await vi.waitFor(() => expect(test.custom).toHaveBeenCalledOnce());

		await test.command?.handler("", test.ctx);
		expect(test.custom).toHaveBeenCalledTimes(2);

		await test.command?.handler("clear", test.ctx);
		expect(test.setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
	});

	it("uses an isolated session id and omits parent context in no-context mode", async () => {
		const test = harness("No context");
		await test.command?.handler("Standalone?", test.ctx);
		await vi.waitFor(() => expect(test.streamSimple).toHaveBeenCalledOnce());
		const [_model, request, options] = test.streamSimple.mock.calls[0] ?? [];
		expect(request).toEqual({
			messages: [{ role: "user", content: [{ type: "text", text: "Standalone?" }], timestamp: expect.any(Number) }],
		});
		expect(options?.sessionId).not.toBe("parent-session");

		await test.command?.handler("clear", test.ctx);
		test.response.resolve(assistant([{ type: "text", text: "Late answer" }]));
		await Promise.resolve();
		expect(test.setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
	});
});
