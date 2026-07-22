import { fauxAssistantMessage, fauxThinking, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setContextPruningEnabled, type ContextPruneDetailsV1 } from "../../../shared/context-pruning-state.ts";

const settings = vi.hoisted(() => ({
	enabled: true,
	nudgeEveryPercent: 20,
	pressurePercent: 50,
	minimumReclaimTokens: 8_000,
}));
vi.mock("../../../shared/settings/load.ts", () => ({
	loadTauExtensionSettings: async () => ({ ...settings }),
}));

import contextPruningExtension from "../../../extensions/context-pruning/index.ts";

type Handler = (...args: unknown[]) => unknown;

function persistedDetails(): ContextPruneDetailsV1 {
	return {
		v: 1,
		status: "applied",
		anchorToolCallId: "anchor",
		newlyPrunedToolCallIds: ["old"],
		newlyPrunedAutoreadRowIds: [],
		retainedToolCallIds: [],
		retainedAutoreadRowIds: [],
		refreshedFiles: [],
		deferredFiles: [],
		tokensBefore: 20,
		tokensAfter: 10,
		tokensReclaimed: 10,
	};
}

function result(id: string, name: string, details?: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 1,
		...(details === undefined ? {} : { details }),
	};
}

function appliedBranch(): unknown[] {
	return [
		{ type: "message", message: fauxAssistantMessage(fauxToolCall("read", {}, { id: "old" })) },
		{ type: "message", message: result("old", "read") },
		{
			type: "message",
			message: fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" })),
		},
		{ type: "message", message: result("anchor", "context_prune", persistedDetails()) },
	];
}

function automaticNudgeEntry(boundary: number, percent = boundary): unknown {
	return {
		type: "custom_message",
		customType: "tau.context-pruning.nudge",
		content: "internal",
		display: true,
		details: {
			v: 1,
			kind: "automatic",
			percent,
			boundary,
			pressure: percent > settings.pressurePercent,
			anchorToolCallId: null,
			growthBaselinePercent: 0,
		},
	};
}

interface RegisteredCommand {
	name: string;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

function harness(activeBranch: unknown[]) {
	const handlers = new Map<string, Handler[]>();
	const tools: ToolDefinition[] = [];
	const commands: RegisteredCommand[] = [];
	const renderers = new Map<string, Handler>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const notifications: Array<{ message: string; type: unknown }> = [];
	let activeTools = ["read", "other-tool"];
	let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	const events = createEventBus();
	const pi = {
		events,
		on(name: string, handler: Handler) {
			const selected = handlers.get(name) ?? [];
			selected.push(handler);
			handlers.set(name, selected);
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.push({ name, handler: command.handler });
		},
		registerMessageRenderer(name: string, renderer: Handler) {
			renderers.set(name, renderer);
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
		appendEntry(customType: string, data: unknown) {
			activeBranch.push({ type: "custom", customType, data });
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]) {
			activeTools = [...toolNames];
		},
	} as unknown as ExtensionAPI;
	contextPruningExtension(pi);
	const ctx = {
		cwd: "/tmp",
		isProjectTrusted: () => true,
		getContextUsage: () => usage,
		ui: {
			notify(message: string, type: unknown) {
				notifications.push({ message, type });
			},
		},
		sessionManager: {
			getBranch: () => activeBranch,
			buildContextEntries: () => activeBranch,
		},
	} as unknown as ExtensionContext;
	return {
		handlers,
		tools,
		commands,
		renderers,
		sent,
		notifications,
		pi,
		ctx,
		getActiveTools: () => [...activeTools],
		setUsage(percent: number | null | undefined) {
			usage =
				percent === undefined
					? undefined
					: { tokens: percent === null ? null : percent * 1_000, contextWindow: 100_000, percent };
		},
		async run(name: string, event: unknown): Promise<unknown> {
			let returned: unknown;
			for (const handler of handlers.get(name) ?? []) {
				const value = await handler(event, ctx);
				if (value !== undefined) returned = value;
			}
			return returned;
		},
	};
}

type TestHarness = ReturnType<typeof harness>;

async function start(test: TestHarness, reason = "startup"): Promise<void> {
	await test.run("session_start", { type: "session_start", reason });
}

async function toolTurn(test: TestHarness, percent: number | null | undefined, toolCallId: string): Promise<void> {
	test.setUsage(percent);
	await test.run("turn_end", { type: "turn_end", toolResults: [result(toolCallId, "read")] });
}

async function executeEmptyPrune(test: TestHarness) {
	const tool = test.tools[0];
	if (!tool) throw new Error("expected context_prune tool");
	return tool.execute("anchor", { keepFiles: [], keepToolCalls: [], deferFiles: [] }, undefined, undefined, test.ctx);
}

function captureRowSnapshots(test: TestHarness): unknown[] {
	const snapshots: unknown[] = [];
	test.pi.events.on("tau:tool-row-state.snapshot", (snapshot) => snapshots.push(snapshot));
	return snapshots;
}

afterEach(() => {
	setContextPruningEnabled(false);
	settings.enabled = true;
	settings.nudgeEveryPercent = 20;
	settings.pressurePercent = 50;
	settings.minimumReclaimTokens = 8_000;
});

describe("context pruning extension wiring", () => {
	it("registers the sequential tool, strict schema, command, and message renderer only after enabled startup", async () => {
		const activeBranch = appliedBranch();
		const test = harness(activeBranch);
		expect(test.tools).toEqual([]);
		expect(test.commands).toEqual([]);
		expect(test.renderers.has("tau.context-pruning.nudge")).toBe(true);
		await start(test);

		expect(test.tools).toHaveLength(1);
		expect(test.tools[0]?.name).toBe("context_prune");
		expect(test.tools[0]?.executionMode).toBe("sequential");
		expect(test.tools[0]?.parameters).toMatchObject({
			additionalProperties: false,
			required: ["keepFiles", "keepToolCalls", "deferFiles"],
		});
		expect(test.commands.map((command) => command.name)).toEqual(["prune"]);
		expect(test.handlers.has("session_before_compact")).toBe(false);

		const old = fauxAssistantMessage([fauxThinking("old"), fauxToolCall("read", {}, { id: "old" })]);
		const anchor = fauxAssistantMessage([
			fauxThinking("anchor"),
			fauxToolCall("context_prune", {}, { id: "anchor" }),
		]);
		const event: ContextEvent = {
			type: "context",
			messages: [old, result("old", "read"), anchor, result("anchor", "context_prune")],
		};
		const projected = (await test.run("context", event)) as { messages: ContextEvent["messages"] };
		expect(projected.messages).toHaveLength(2);
	});

	it("implements /prune usage rejection and hidden steering with an immediate turn", async () => {
		const test = harness([]);
		await start(test);
		const command = test.commands[0];
		if (!command) throw new Error("expected prune command");

		await command.handler("now", test.ctx as unknown as ExtensionCommandContext);
		expect(test.notifications).toEqual([{ message: "Usage: /prune", type: "info" }]);
		expect(test.sent).toEqual([]);

		await command.handler("", test.ctx as unknown as ExtensionCommandContext);
		expect(test.sent).toHaveLength(1);
		expect(test.sent[0]).toEqual({
			message: expect.objectContaining({
				customType: "tau.context-pruning.nudge",
				display: true,
				details: expect.objectContaining({ kind: "manual", percent: null }),
			}),
			options: { deliverAs: "steer", triggerTurn: true },
		});
		const manualMessage = test.sent[0]?.message;
		if (!manualMessage) throw new Error("expected manual prune message");
		expect((manualMessage as { content: string }).content).toContain("continue unfinished work");
	});

	it("deactivates and gates a previously registered tool and command when a later session disables the feature", async () => {
		const test = harness([]);
		await start(test);
		expect(test.getActiveTools()).toEqual(["read", "other-tool", "context_prune"]);
		settings.enabled = false;
		await start(test, "new");
		expect(test.getActiveTools()).toEqual(["read", "other-tool"]);

		const command = test.commands[0];
		if (!command) throw new Error("expected prune command");
		await command.handler("", test.ctx as unknown as ExtensionCommandContext);
		expect(test.sent).toEqual([]);
		expect(test.notifications.at(-1)).toEqual({ message: "Context pruning is disabled.", type: "info" });

		const execution = await executeEmptyPrune(test);
		expect(execution.details).toMatchObject({ status: "skipped" });
		expect(execution.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("disabled") });
	});

	it("emits only the strongest newly crossed boundary with informational and pressure wording", async () => {
		const test = harness([]);
		await start(test);
		await toolTurn(test, 45, "read");
		expect(test.sent).toHaveLength(1);
		expect(test.sent[0]?.message).toMatchObject({
			details: { kind: "automatic", percent: 45, boundary: 40, pressure: false },
		});
		const informationalMessage = test.sent[0]?.message;
		if (!informationalMessage) throw new Error("expected informational nudge");
		expect((informationalMessage as { content: string }).content).toContain("No prune is required");

		await toolTurn(test, 65, "grep");
		expect(test.sent).toHaveLength(2);
		expect(test.sent[1]?.message).toMatchObject({
			details: { kind: "automatic", percent: 65, boundary: 60, pressure: true },
		});
		const pressureMessage = test.sent[1]?.message;
		if (!pressureMessage) throw new Error("expected pressure nudge");
		expect((pressureMessage as { content: string }).content).toContain("Finish the current coherent step");
		expect((pressureMessage as { content: string }).content).not.toContain("65");
	});

	it("skips nudges without usage or tool results", async () => {
		const test = harness([]);
		await start(test);
		await toolTurn(test, undefined, "read");
		await toolTurn(test, null, "read-null");
		test.setUsage(45);
		await test.run("turn_end", { type: "turn_end", toolResults: [] });
		expect(test.sent).toEqual([]);
	});

	it("reconstructs emitted boundaries after tree navigation", async () => {
		const activeBranch = [automaticNudgeEntry(40, 45)];
		const test = harness(activeBranch);
		await start(test);
		await toolTurn(test, 45, "read");
		expect(test.sent).toEqual([]);

		await toolTurn(test, 65, "read-2");
		expect(test.sent).toHaveLength(1);
		expect(test.sent[0]?.message).toMatchObject({ details: { boundary: 60 } });
		activeBranch.push(automaticNudgeEntry(60, 65));
		await test.run("session_tree", { type: "session_tree" });
		await test.run("turn_end", { type: "turn_end", toolResults: [result("read-3", "read")] });
		expect(test.sent).toHaveLength(1);
		await test.run("session_compact", { type: "session_compact", reason: "threshold" });
		await toolTurn(test, 85, "read-4");
		expect(test.sent).toHaveLength(2);
		expect(test.sent[1]?.message).toMatchObject({ details: { boundary: 80 } });
	});

	it("waits for a full growth interval after an applied prune", async () => {
		const test = harness(appliedBranch());
		await start(test);
		for (const percent of [30, 49]) {
			await toolTurn(test, percent, `read-${percent}`);
		}
		expect(test.sent).toEqual([]);
		await toolTurn(test, 51, "read-51");
		expect(test.sent).toHaveLength(1);
		expect(test.sent[0]?.message).toMatchObject({
			details: { boundary: 40, growthBaselinePercent: 30, anchorToolCallId: "anchor" },
		});
	});

	it("persists and reconstructs the first post-prune usage baseline across compact and tree events", async () => {
		const activeBranch = appliedBranch();
		const test = harness(activeBranch);
		await start(test);
		await toolTurn(test, 30, "read-30");
		expect(activeBranch.at(-1)).toEqual({
			type: "custom",
			customType: "tau.context-pruning.nudge-baseline",
			data: { v: 1, anchorToolCallId: "anchor", baselinePercent: 30 },
		});
		await test.run("session_compact", { type: "session_compact", reason: "threshold" });
		await toolTurn(test, 49, "read-49");
		expect(test.sent).toEqual([]);

		activeBranch.pop();
		activeBranch.push({
			type: "custom",
			customType: "tau.context-pruning.nudge-baseline",
			data: { v: 1, anchorToolCallId: "anchor", baselinePercent: 1, extra: true },
		});
		await test.run("session_tree", { type: "session_tree" });
		await test.run("turn_end", { type: "turn_end", toolResults: [result("read-new-baseline", "read")] });
		expect(test.sent).toEqual([]);
		expect(activeBranch.at(-1)).toMatchObject({
			type: "custom",
			data: { baselinePercent: 49 },
		});
		await toolTurn(test, 70, "read-70");
		expect(test.sent.at(-1)?.message).toMatchObject({
			details: { anchorToolCallId: "anchor", growthBaselinePercent: 49, boundary: 60 },
		});
	});

	it("does not publish planned visual state before the applied tool result is branch-visible", async () => {
		settings.minimumReclaimTokens = 1;
		const oldCall = fauxAssistantMessage(fauxToolCall("grep", {}, { id: "old" }));
		const anchorCall = fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" }));
		const activeBranch = [
			{ type: "message", message: oldCall },
			{ type: "message", message: result("old", "grep", "x".repeat(40_000)) },
			{ type: "message", message: anchorCall },
		];
		const test = harness(activeBranch);
		const snapshots = captureRowSnapshots(test);
		await start(test);
		await test.run("context", {
			type: "context",
			messages: [oldCall, result("old", "grep", "x".repeat(40_000))],
		});
		const execution = await executeEmptyPrune(test);
		expect(execution.details).toMatchObject({ status: "applied", newlyPrunedToolCallIds: ["old"] });
		expect(snapshots.at(-1)).toEqual({ states: [] });
		activeBranch.push({ type: "message", message: result("anchor", "context_prune", execution.details) });
		await test.run("context", {
			type: "context",
			messages: [oldCall, result("old", "grep"), anchorCall, result("anchor", "context_prune", execution.details)],
		});
		expect(snapshots.at(-1)).toEqual({ states: [{ rowId: "old", state: "pruned" }] });
	});

	it("prunes after an aborted assistant response left an unmatched tool call", async () => {
		settings.minimumReclaimTokens = 1;
		const noiseCall = fauxAssistantMessage(fauxToolCall("grep", {}, { id: "noise" }));
		const noiseResult = result("noise", "grep", "x".repeat(40_000));
		const abandoned = fauxAssistantMessage(fauxToolCall("bash", { command: "blocked" }, { id: "abandoned" }), {
			stopReason: "aborted",
			errorMessage: "Operation aborted",
		});
		const anchorCall = fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" }));
		const activeBranch = [
			{ type: "message", message: noiseCall },
			{ type: "message", message: noiseResult },
			{ type: "message", message: abandoned },
			{ type: "message", message: anchorCall },
		];
		const test = harness(activeBranch);
		await start(test);
		const projected = (await test.run("context", {
			type: "context",
			messages: [noiseCall, noiseResult, abandoned],
		})) as { messages: ContextEvent["messages"] };
		expect(projected.messages).toEqual([noiseCall, noiseResult]);

		const execution = await executeEmptyPrune(test);
		expect(execution.details).toMatchObject({
			status: "applied",
			newlyPrunedToolCallIds: ["noise"],
		});
	});

	it("replays and clears complete row snapshots across start, tree, compact, and shutdown", async () => {
		const activeBranch = appliedBranch();
		const test = harness(activeBranch);
		const snapshots = captureRowSnapshots(test);
		await start(test);
		expect(snapshots.at(-1)).toEqual({ states: [{ rowId: "old", state: "pruned" }] });

		activeBranch.splice(0);
		await test.run("session_tree", { type: "session_tree" });
		expect(snapshots.at(-1)).toEqual({ states: [] });
		activeBranch.push(...appliedBranch());
		await test.run("session_compact", { type: "session_compact", reason: "threshold" });
		expect(snapshots.at(-1)).toEqual({ states: [{ rowId: "old", state: "pruned" }] });
		await test.run("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(snapshots.at(-1)).toEqual({ states: [] });
	});

	it("does not cancel or replace manual, threshold, or overflow compaction", async () => {
		const test = harness([]);
		await start(test);
		expect(test.handlers.has("session_before_compact")).toBe(false);
		for (const reason of ["manual", "threshold", "overflow"] as const) {
			await expect(
				test.run("session_compact", {
					type: "session_compact",
					reason,
					willRetry: reason === "overflow",
				}),
			).resolves.toBeUndefined();
		}
	});

	it("disables tools, commands, projection, nudges, and visual state together", async () => {
		settings.enabled = false;
		const test = harness(appliedBranch());
		const snapshots = captureRowSnapshots(test);
		await start(test);
		expect(test.tools).toEqual([]);
		expect(test.commands).toEqual([]);
		expect(test.renderers.has("tau.context-pruning.nudge")).toBe(true);
		expect(await test.run("context", { type: "context", messages: [] })).toBeUndefined();
		test.setUsage(80);
		await test.run("turn_end", { type: "turn_end", toolResults: [result("read", "read")] });
		expect(test.sent).toEqual([]);
		expect(snapshots.at(-1)).toEqual({ states: [] });
	});
});
