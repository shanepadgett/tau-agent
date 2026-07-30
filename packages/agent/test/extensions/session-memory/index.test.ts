import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	initTheme,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sessionMemoryExtension from "../../../extensions/session-memory/index.ts";
import type { SessionMemoryInput } from "../../../extensions/session-memory/state.ts";
import { renderedText, testTheme } from "../../helpers.ts";

const mocks = vi.hoisted(() => ({ loadTauExtensionSettings: vi.fn() }));

vi.mock("../../../shared/settings/load.ts", () => ({
	loadTauExtensionSettings: mocks.loadTauExtensionSettings,
}));

type Handler = (event: never, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type PanelFactory = (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: void) => void) => Component;

interface RegisteredCommand {
	handler: CommandHandler;
}

interface RegisteredTool {
	name: string;
	description: string;
	promptGuidelines: readonly string[];
	parameters: unknown;
	renderShell: "self";
	renderCall(
		args: SessionMemoryInput,
		theme: Theme,
		context: {
			toolCallId: string;
			invalidate: () => void;
			lastComponent: Component | undefined;
			executionStarted: boolean;
			isError: boolean;
		},
	): Component;
	execute(
		toolCallId: string,
		params: SessionMemoryInput,
		signal: AbortSignal | undefined,
		onUpdate: never,
		ctx: ExtensionContext,
	): Promise<{ content: ToolResultMessage["content"]; details: unknown }>;
}

const update: Extract<SessionMemoryInput, { action: "update" }> = {
	action: "update",
	longTermGoal: "Ship session memory",
	tasks: ["Project checkpoint"],
	shortTermMemories: [],
	longTermMemories: [{ id: "cache-stability", text: "Keep tool definitions stable." }],
	readFiles: [],
	outlineFiles: [],
	deferFiles: [],
};

function harness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	let activeTools = ["read"];
	let tool: RegisteredTool | undefined;
	const pi = {
		events: createEventBus(),
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerMessageRenderer() {},
		registerTool(value: RegisteredTool) {
			tool = value;
			activeTools.push(value.name);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		sendMessage(message: unknown, options?: unknown) {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	sessionMemoryExtension(pi);
	return {
		activeTools: () => [...activeTools],
		command(name: string) {
			const command = commands.get(name);
			if (!command) throw new Error(`${name} was not registered`);
			return command.handler;
		},
		sent,
		tool: () => {
			if (!tool) throw new Error("session_memory was not registered");
			return tool;
		},
		async emit(name: string, event: unknown, ctx: ExtensionContext) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = (await handler(event as never, ctx)) ?? result;
			return result;
		},
	};
}

function context(branch: SessionEntry[], tokens: () => number): ExtensionContext {
	return {
		cwd: "/work",
		mode: "print",
		hasUI: false,
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: tokens() }),
		sessionManager: { getBranch: () => branch },
		ui: { setWidget() {}, notify() {} },
	} as unknown as ExtensionContext;
}

function callEntry(id: string): SessionEntry {
	return {
		type: "message",
		id: `${id}-call`,
		parentId: null,
		timestamp: "2026-07-29T12:00:00.000Z",
		message: fauxAssistantMessage(fauxToolCall("session_memory", update, { id })),
	};
}

describe("session-memory extension", () => {
	beforeAll(() => initTheme());

	beforeEach(() => {
		mocks.loadTauExtensionSettings.mockReset();
		mocks.loadTauExtensionSettings.mockResolvedValue({
			enabled: true,
			showToolRows: false,
			contextCeilingTokens: 150_000,
		});
	});

	it("blocks every other tool until a required update is projected without changing tools", async () => {
		const test = harness();
		const branch: SessionEntry[] = [];
		let tokens = 120_000;
		const ctx = context(branch, () => tokens);
		await test.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const registered = test.tool();
		const toolFingerprint = JSON.stringify({
			name: registered.name,
			description: registered.description,
			promptGuidelines: registered.promptGuidelines,
			parameters: registered.parameters,
		});
		const activeTools = test.activeTools();

		expect(await test.emit("before_agent_start", { type: "before_agent_start" }, ctx)).toMatchObject({
			message: { details: { kind: "required", boundaryTokens: 120_000 }, display: false },
		});
		expect(
			await test.emit("tool_call", { type: "tool_call", toolCallId: "blocked", toolName: "read", input: {} }, ctx),
		).toEqual({
			block: true,
			reason: "Checkpoint required. Update session memory first.",
		});

		branch.push(callEntry("required-update"));
		expect(
			await test.emit(
				"tool_call",
				{ type: "tool_call", toolCallId: "required-update", toolName: "session_memory", input: update },
				ctx,
			),
		).toBeUndefined();
		const execution = await registered.execute("required-update", update, undefined, undefined as never, ctx);
		expect(execution.details).toMatchObject({ kind: "checkpoint", checkpoint: 1 });
		expect(
			await test.emit("tool_call", { type: "tool_call", toolCallId: "sibling", toolName: "read", input: {} }, ctx),
		).toEqual({
			block: true,
			reason: "Checkpoint projection is pending.",
		});

		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "required-update",
			toolName: "session_memory",
			content: execution.content,
			details: execution.details,
			isError: false,
			timestamp: 1,
		};
		branch.push({
			type: "message",
			id: "required-update-result",
			parentId: "required-update-call",
			timestamp: "2026-07-29T12:00:01.000Z",
			message: result,
		});
		tokens = 1_000;
		const projected = await test.emit(
			"context",
			{ type: "context", messages: [branch[0]?.type === "message" ? branch[0].message : result, result] },
			ctx,
		);
		expect(projected).toMatchObject({ messages: [{ role: "assistant" }, { role: "toolResult" }] });
		expect(
			await test.emit("tool_call", { type: "tool_call", toolCallId: "read", toolName: "read", input: {} }, ctx),
		).toBeUndefined();
		expect(test.activeTools()).toEqual(activeTools);
		expect(
			JSON.stringify({
				name: registered.name,
				description: registered.description,
				promptGuidelines: registered.promptGuidelines,
				parameters: registered.parameters,
			}),
		).toBe(toolFingerprint);
	});

	it("hides tool rows by default and shows them when enabled for debugging", async () => {
		const hidden = harness();
		const ctx = context([], () => 1_000);
		await hidden.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const renderContext = {
			toolCallId: "memory-call",
			invalidate() {},
			lastComponent: undefined,
			executionStarted: false,
			isError: false,
		};
		expect(hidden.tool().renderShell).toBe("self");
		expect(renderedText(hidden.tool().renderCall(update, testTheme, renderContext))).toBe("");

		mocks.loadTauExtensionSettings.mockResolvedValue({
			enabled: true,
			showToolRows: true,
			contextCeilingTokens: 150_000,
		});
		const visible = harness();
		await visible.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(renderedText(visible.tool().renderCall(update, testTheme, renderContext))).toContain("session_memory");
	});

	it("uses smaller model windows for required gates and resets stale gate IDs on branch changes", async () => {
		const test = harness();
		const branch: SessionEntry[] = [];
		let tokens = 40_000;
		const ctx = { ...context(branch, () => tokens), model: { contextWindow: 70_000 } } as unknown as ExtensionContext;
		await test.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(await test.emit("before_agent_start", { type: "before_agent_start" }, ctx)).toMatchObject({
			message: { details: { kind: "required", boundaryTokens: 40_000 } },
		});
		tokens = 1_000;
		await test.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null }, ctx);
		expect(
			await test.emit("tool_call", { type: "tool_call", toolCallId: "read", toolName: "read", input: {} }, ctx),
		).toBeUndefined();
	});

	it("lets an admitted tool batch finish before requiring the next turn to checkpoint", async () => {
		const test = harness();
		const branch: SessionEntry[] = [];
		let tokens = 10_000;
		const ctx = context(branch, () => tokens);
		await test.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(await test.emit("before_agent_start", { type: "before_agent_start" }, ctx)).toBeUndefined();

		expect(
			await test.emit(
				"tool_call",
				{ type: "tool_call", toolCallId: "large-patch", toolName: "patch", input: {} },
				ctx,
			),
		).toBeUndefined();
		tokens = 130_000;
		expect(
			await test.emit(
				"tool_call",
				{ type: "tool_call", toolCallId: "sibling-patch", toolName: "patch", input: {} },
				ctx,
			),
		).toBeUndefined();
		expect(test.sent).toEqual([]);

		await test.emit("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
		expect(test.sent).toEqual([
			expect.objectContaining({
				message: expect.objectContaining({ details: { v: 1, kind: "required", boundaryTokens: 120_000 } }),
				options: { deliverAs: "steer" },
			}),
		]);
		expect(
			await test.emit("tool_call", { type: "tool_call", toolCallId: "blocked", toolName: "patch", input: {} }, ctx),
		).toEqual({
			block: true,
			reason: "Checkpoint required. Update session memory first.",
		});

		branch.push(callEntry("required-update"));
		expect(
			await test.emit(
				"tool_call",
				{ type: "tool_call", toolCallId: "required-update", toolName: "session_memory", input: update },
				ctx,
			),
		).toBeUndefined();
		const execution = await test.tool().execute("required-update", update, undefined, undefined as never, ctx);
		expect(execution.details).toMatchObject({ kind: "checkpoint", checkpoint: 1 });
	});

	it("guides goal and task lifecycle before final responses and manual checkpoints", async () => {
		const test = harness();
		const branch: SessionEntry[] = [];
		const ctx = context(branch, () => 1_000);
		await test.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(test.tool().promptGuidelines).toContain(
			"Set longTermGoal to null unless work needs durable direction across many tasks or checkpoints that tasks alone cannot capture. Change it when that direction changes.",
		);
		expect(test.tool().promptGuidelines).toContain(
			"Keep tasks as ordered unfinished work with the current task first. Remove completed or abandoned tasks immediately.",
		);
		expect(test.tool().promptGuidelines).toContain(
			"Before a final response, use action update to reconcile session memory whenever task status or other saved state changed.",
		);

		await test.command("prune")("", ctx as ExtensionCommandContext);
		expect(test.sent).toEqual([
			expect.objectContaining({
				message: expect.objectContaining({
					content: expect.stringContaining("remove completed or abandoned tasks"),
				}),
			}),
		]);
	});

	it("opens an interactive panel before any memory has been recorded", async () => {
		const test = harness();
		const branch: SessionEntry[] = [];
		const base = context(branch, () => 1_000);
		const output: string[] = [];
		const done = vi.fn();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const theme = {
			fg: (_name: string, text: string) => text,
			bg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const keys = {
			matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\x1b",
		} as unknown as KeybindingsManager;
		const custom = vi.fn(async (factory: PanelFactory) => {
			const component = factory(tui, theme, keys, done);
			output.push(component.render(80).join("\n"));
			component.handleInput?.("\x1b[C");
			output.push(component.render(80).join("\n"));
			component.handleInput?.("\x1b");
		});
		const ctx = {
			...base,
			mode: "tui",
			hasUI: true,
			ui: { custom, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await test.emit("session_start", { type: "session_start", reason: "startup" }, ctx as ExtensionContext);
		await test.command("session-memory")("", ctx);

		expect(custom).toHaveBeenCalledOnce();
		expect(output[0]).toContain("LONG-TERM GOAL  None");
		expect(output[0]).toContain("not saved yet");
		expect(output[1]).toContain("Short term  0");
		expect(tui.requestRender).toHaveBeenCalledOnce();
		expect(done).toHaveBeenCalledOnce();
	});
});
