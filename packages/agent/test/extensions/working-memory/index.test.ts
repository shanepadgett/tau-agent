import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import workingMemoryExtension from "../../../extensions/working-memory/index.ts";

const mocks = vi.hoisted(() => ({
	loadTauExtensionSettings: vi.fn(),
}));

vi.mock("../../../shared/settings/load.ts", () => ({
	loadTauExtensionSettings: mocks.loadTauExtensionSettings,
}));

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

function harness(): { emit(name: string, event: unknown, ctx: ExtensionContext): Promise<unknown> } {
	const handlers = new Map<string, Handler[]>();
	let activeTools: string[] = [];
	const pi = {
		events: createEventBus(),
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerMessageRenderer() {},
		registerTool(tool: { name: string }) {
			activeTools = [...activeTools, tool.name];
		},
		registerCommand() {},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
	} as unknown as ExtensionAPI;
	workingMemoryExtension(pi);
	return {
		async emit(name, event, ctx) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
			return result;
		},
	};
}

describe("working-memory extension", () => {
	beforeEach(() => {
		mocks.loadTauExtensionSettings.mockReset();
		mocks.loadTauExtensionSettings.mockResolvedValue({
			enabled: true,
			nudgeEveryTokens: 40_000,
			nudgeInstructions: ["Reassess working memory."],
		});
	});

	it("injects a hidden message without changing the system prompt after the nudge threshold", async () => {
		const test = harness();
		const branch: never[] = [];
		const context = {
			cwd: process.cwd(),
			isProjectTrusted: () => true,
			getContextUsage: () => ({ tokens: 40_000 }),
			sessionManager: {
				getBranch: () => branch,
				buildContextEntries: () => branch,
			},
		} as unknown as ExtensionContext;
		await test.emit("session_start", { type: "session_start", reason: "startup" }, context);

		const result = (await test.emit(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "continue", systemPrompt: "stable" },
			context,
		)) as { message?: { customType: string; content: string; display: boolean }; systemPrompt?: string };

		expect(result.systemPrompt).toBeUndefined();
		expect(result.message).toMatchObject({
			customType: "tau.working-memory.nudge",
			content: expect.stringContaining("Reassess working memory."),
			display: false,
		});
		expect(await test.emit("before_agent_start", { prompt: "next" }, context)).toMatchObject({
			message: { customType: "tau.working-memory.nudge", display: false },
		});
	});
});
