import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import effortExtension from "../../../extensions/effort/index.ts";

describe("effort extension", () => {
	it("keeps effort active when Pi emits its thinking event after selection returns", async () => {
		const selectedModel = { provider: "openai-codex", id: "gpt-5.6-sol" } as Model<Api>;
		let thinking: ThinkingLevel = "medium";
		let thinkingHandler: ((event: { level: ThinkingLevel }, ctx: ExtensionCommandContext) => void) | undefined;
		let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
		const entries: unknown[] = [];
		const ctx = {
			hasUI: true,
			model: selectedModel,
			modelRegistry: {
				getAvailable: () => [selectedModel],
				getProviderDisplayName: () => "OpenAI",
			},
			ui: {
				notify: vi.fn(),
				select: vi.fn(async () => "OpenAI · openai-codex"),
			},
			waitForIdle: vi.fn(async () => {}),
		} as unknown as ExtensionCommandContext;
		const pi = {
			appendEntry: (_type: string, data: unknown) => entries.push(data),
			events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
			getThinkingLevel: () => thinking,
			model: selectedModel,
			on: (event: string, handler: unknown) => {
				if (event === "thinking_level_select") {
					thinkingHandler = handler as (event: { level: ThinkingLevel }, ctx: ExtensionCommandContext) => void;
				}
			},
			registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
				commandHandler = options.handler;
			},
			registerShortcut: vi.fn(),
			setModel: vi.fn(async () => true),
			setThinkingLevel: (level: ThinkingLevel) => {
				thinking = level;
				queueMicrotask(() => {
					thinkingHandler?.({ level }, ctx);
				});
			},
		} as unknown as ExtensionAPI;
		effortExtension(pi);

		await commandHandler?.("high", ctx);
		await Promise.resolve();

		expect(entries).toEqual([{ v: 1, effort: "high" }]);
	});
});
