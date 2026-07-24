import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import exploreExtension from "../../../extensions/explore/index.ts";

describe("explore extension", () => {
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
		expect(tools).toEqual(expect.arrayContaining(["outline", "symbol", "ls", "find", "grep", "read"]));
	});
});
