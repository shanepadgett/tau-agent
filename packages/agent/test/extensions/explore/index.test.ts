import {
	createEventBus,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const guidance = vi.hoisted(() =>
	vi.fn(async (): Promise<string | undefined> => "## Explore source policy\n\nTypeScript guidance"),
);
vi.mock("../../../extensions/explore/ast-guidance.ts", () => ({
	AST_DISCOVERY_BUDGET: 4096,
	effectiveAstGuidance: guidance,
}));

import exploreExtension from "../../../extensions/explore/index.ts";

describe("explore extension", () => {
	beforeEach(() => {
		guidance.mockClear();
		guidance.mockResolvedValue("## Explore source policy\n\nTypeScript guidance");
	});

	it("registers non-AST tools without starting the worker", () => {
		const tools: string[] = [];
		const pi = {
			events: createEventBus(),
			registerTool(tool: { name: string }) {
				tools.push(tool.name);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			on() {},
		} as unknown as ExtensionAPI;
		expect(() => exploreExtension(pi)).not.toThrow();
		expect(tools).toEqual(
			expect.arrayContaining(["outline", "symbol", "api_discover", "ast_search", "ls", "find", "grep", "read"]),
		);
		expect(guidance).not.toHaveBeenCalled();
	});

	it("appends effective repository guidance to the chained prompt", async () => {
		type Handler = (...args: unknown[]) => unknown;
		const handlers = new Map<string, Handler>();
		const pi = {
			events: createEventBus(),
			registerTool() {},
			registerCommand() {},
			registerMessageRenderer() {},
			on(name: string, handler: Handler) {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI;
		exploreExtension(pi);
		const event = { systemPrompt: "Pi base" } as BeforeAgentStartEvent;
		const ctx = { cwd: "/workspace" } as ExtensionContext;
		const result = (await handlers.get("before_agent_start")?.(event, ctx)) as BeforeAgentStartEventResult;
		expect(result.systemPrompt).toBe("Pi base\n\n## Explore source policy\n\nTypeScript guidance");
		expect(guidance).toHaveBeenCalledWith({
			cwd: "/workspace",
			workerLanguages: expect.any(Function),
			discoveryBudget: 4096,
		});

		guidance.mockResolvedValue(undefined);
		expect(await handlers.get("before_agent_start")?.(event, ctx)).toBeUndefined();
	});
});
