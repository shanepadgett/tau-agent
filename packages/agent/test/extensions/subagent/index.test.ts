import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import subagentExtension from "../../../extensions/subagent/index.ts";

describe("subagent extension", () => {
	it("registers one strict parallel tool", () => {
		const tools: Array<{
			name: string;
			executionMode?: string;
			parameters: { required?: string[]; additionalProperties?: boolean; properties?: Record<string, unknown> };
		}> = [];
		const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
		const pi = {
			events: createEventBus(),
			registerTool(tool: (typeof tools)[number]) {
				tools.push(tool);
			},
			on(name: string, handler: (...args: never[]) => unknown) {
				const current = handlers.get(name) ?? [];
				current.push(handler);
				handlers.set(name, current);
			},
		} as unknown as ExtensionAPI;

		subagentExtension(pi);
		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("subagent");
		expect(tools[0]?.executionMode).toBe("parallel");
		expect(tools[0]?.parameters.required).toEqual(["agent", "task"]);
		expect(Object.keys(tools[0]?.parameters.properties ?? {})).toEqual(["agent", "task"]);
		expect(tools[0]?.parameters.additionalProperties).toBe(false);
	});
});
