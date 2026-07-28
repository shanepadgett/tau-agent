import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import subagentExtension from "../../../extensions/subagent/index.ts";

describe("subagent extension", () => {
	it("registers one strict parallel tool and the session command", () => {
		const tools: Array<{
			name: string;
			executionMode?: string;
			parameters: {
				anyOf?: Array<{
					required?: string[];
					additionalProperties?: boolean;
					properties?: Record<string, unknown>;
				}>;
			};
		}> = [];
		const commands: string[] = [];
		const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
		const pi = {
			events: createEventBus(),
			registerTool(tool: (typeof tools)[number]) {
				tools.push(tool);
			},
			registerCommand(name: string) {
				commands.push(name);
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
		expect(tools[0]?.parameters.anyOf).toHaveLength(2);
		expect(tools[0]?.parameters.anyOf?.[0]?.required).toEqual(["agent", "task"]);
		expect(Object.keys(tools[0]?.parameters.anyOf?.[0]?.properties ?? {})).toEqual(["agent", "task", "files"]);
		expect(tools[0]?.parameters.anyOf?.[0]?.additionalProperties).toBe(false);
		expect(tools[0]?.parameters.anyOf?.[1]?.required).toEqual(["thread", "task"]);
		expect(Object.keys(tools[0]?.parameters.anyOf?.[1]?.properties ?? {})).toEqual(["thread", "task", "files"]);
		expect(tools[0]?.parameters.anyOf?.[1]?.additionalProperties).toBe(false);
		expect(commands).toEqual(["agents"]);
	});

	it("hides agents disabled by settings or the current session", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-subagent-index-"));
		try {
			await mkdir(join(root, ".pi", "tau"), { recursive: true });
			await writeFile(
				join(root, ".pi", "tau", "settings.json"),
				JSON.stringify({ extensions: { subagent: { disabled: ["web-research"] } } }),
			);
			const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown | Promise<unknown>>>();
			let executeTool:
				| ((
						id: string,
						params: { agent: string; task: string },
						signal: AbortSignal | undefined,
						onUpdate: undefined,
						ctx: unknown,
				  ) => Promise<{ content: Array<{ text: string }> }>)
				| undefined;
			const pi = {
				events: createEventBus(),
				registerTool(tool: { execute: typeof executeTool }) {
					executeTool = tool.execute;
				},
				registerCommand() {},
				on(name: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				},
				getActiveTools: () => ["subagent"],
				getThinkingLevel: () => "medium",
			} as unknown as ExtensionAPI;
			subagentExtension(pi);
			const ctx = {
				cwd: root,
				isProjectTrusted: () => true,
				sessionManager: {
					getBranch: () => [
						{
							type: "custom",
							customType: "tau.subagent.disabled",
							data: { disabled: ["scout"] },
						},
					],
				},
				ui: { notify() {} },
			};
			for (const handler of handlers.get("session_tree") ?? []) await handler({}, ctx);
			let result: unknown;
			for (const handler of handlers.get("before_agent_start") ?? []) {
				result = await handler({ systemPrompt: "base" }, ctx);
			}
			const prompt = (result as { systemPrompt?: string } | undefined)?.systemPrompt;
			expect(prompt).not.toContain("- web-research:");
			expect(prompt).not.toContain("- review:");
			expect(prompt).not.toContain("- scout:");
			if (!executeTool) throw new Error("subagent tool was not registered");
			const failed = await executeTool(
				"call-1",
				{ agent: "web-research", task: "Research this" },
				undefined,
				undefined,
				{
					...ctx,
					mode: "print",
					hasUI: false,
				},
			);
			expect(failed.content[0]?.text).toContain("Agent web-research is disabled in Tau settings.");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
