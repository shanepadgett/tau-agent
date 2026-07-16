import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import contextExtension from "../../../extensions/context/index.ts";
import type { ContextEntry } from "../../../extensions/context/definitions.ts";
import type { ContextSyncDetails } from "../../../extensions/context/sync.ts";

interface RegisteredTool {
	name: string;
	parameters: { additionalProperties?: boolean; properties?: Record<string, unknown> };
	execute?: unknown;
	renderCall?: unknown;
	renderResult?: unknown;
}

interface RegisteredCommand {
	handler: unknown;
}

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function harness(): {
	tools: Map<string, RegisteredTool>;
	commands: Map<string, RegisteredCommand>;
	messages: unknown[];
	autoreadRequests: unknown[];
	emit: (name: string, event: unknown) => void;
} {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const messages: unknown[] = [];
	const autoreadRequests: unknown[] = [];
	const handlers = new Map<string, Array<(event: unknown) => void>>();
	const events = createEventBus();
	events.on("tau:autoread.requested", (event) => autoreadRequests.push(event));
	const pi = {
		events,
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		sendMessage(message: unknown) {
			messages.push(message);
		},
		on(name: string, handler: (event: unknown) => void) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	contextExtension(pi);
	return {
		tools,
		commands,
		messages,
		autoreadRequests,
		emit(name, event) {
			for (const handler of handlers.get(name) ?? []) handler(event);
		},
	};
}

const theme = { fg: (_color: string, value: string) => value } as unknown as Theme;

describe("context extension", () => {
	it("registers only the empty sync trigger and current commands", () => {
		const { tools, commands } = harness();
		expect([...tools]).toHaveLength(1);
		expect(tools.has("context_sync")).toBe(true);
		expect(tools.has("submit_context_sync")).toBe(false);
		expect(tools.get("context_sync")?.parameters.additionalProperties).toBe(false);
		expect(tools.get("context_sync")?.parameters.properties).toEqual({});
		expect(new Set(commands.keys())).toEqual(new Set(["context", "context-sync"]));
	});

	it("autoreads eager paths and injects deduplicated lazy anchors", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-context-index-"));
		roots.push(root);
		await mkdir(join(root, ".pi", "contexts", "code"), { recursive: true });
		await writeFile(
			join(root, ".pi", "contexts", "code", "source.toml"),
			'name = "Source"\n\n[all]\ndescription = "Source files"\nfiles = ["src/main.ts"]\n',
		);
		const selected: ContextEntry[] = [
			{
				id: "code/source/runtime",
				tab: "code",
				concept: "source",
				conceptName: "Source",
				conceptDescription: "Source files",
				name: "runtime",
				description: "Runtime source",
				files: ["src/main.ts"],
				anchors: ["src/fetch.ts"],
				path: ".pi/contexts/code/source.toml",
			},
			{
				id: "code/source/integration",
				tab: "code",
				concept: "source",
				conceptName: "Source",
				conceptDescription: "Source files",
				name: "integration",
				description: "Runtime integration",
				files: [],
				anchors: ["src/main.ts", "src/fetch.ts"],
				path: ".pi/contexts/code/source.toml",
			},
		];
		const { commands, messages, autoreadRequests } = harness();
		const command = commands.get("context");
		if (!command) throw new Error("context command was not registered");
		const handler = command.handler as (
			args: string,
			ctx: {
				mode: "tui";
				cwd: string;
				isProjectTrusted(): boolean;
				waitForIdle(): Promise<void>;
				ui: { notify(): void; custom(): Promise<ContextEntry[]> };
			},
		) => Promise<void>;
		await handler("", {
			mode: "tui",
			cwd: root,
			isProjectTrusted: () => true,
			waitForIdle: async () => {},
			ui: { notify() {}, custom: async () => selected },
		});

		expect(autoreadRequests).toMatchObject([{ files: [{ path: "src/main.ts" }] }]);
		const message = messages[0] as { content?: string } | undefined;
		expect(message?.content).toContain("- src/fetch.ts");
		expect(message?.content).not.toContain(
			"Lazy navigation anchors whose contents have not been loaded:\n- src/main.ts",
		);
	});

	it("keeps collapsed rendering compact and exposes the sync reason to the agent", () => {
		const tool = harness().tools.get("context_sync");
		if (!tool) throw new Error("context_sync was not registered");
		const details: ContextSyncDetails = {
			outcome: "applied",
			summary: "Updated 1 context entries; created 0; removed 0.",
			changedContextFiles: [".pi/contexts/code/context.toml"],
			reason: "Membership changed",
			changes: [
				{
					action: "set-entry",
					tab: "code",
					concept: "context",
					conceptName: "Context",
					conceptDescription: "Context code",
					entry: "sync",
					description: "Context sync",
					files: ["src/sync.ts"],
				},
			],
			counts: { created: 0, updated: 1, deleted: 0, unchanged: 0 },
		};
		const result = {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						outcome: details.outcome,
						summary: details.summary,
						reason: details.reason,
						changedContextFiles: details.changedContextFiles,
					}),
				},
			],
			details,
		};
		const context = { toolCallId: "call", invalidate() {}, lastComponent: undefined, expanded: false };
		const renderCall = tool.renderCall as (
			args: Record<string, never>,
			theme: Theme,
			context: Record<string, unknown>,
		) => Component;
		const renderResult = tool.renderResult as (
			value: { content: Array<{ type: string; text: string }>; details: ContextSyncDetails },
			options: Record<string, unknown>,
			theme: Theme,
			context: Record<string, unknown>,
		) => Component;
		expect(renderCall({}, theme, context).render(160).join("\n").trimEnd()).toBe("context_sync");
		expect(renderResult(result, {}, theme, context).render(160).join("\n").trimEnd()).toBe(details.summary);
		expect(
			renderResult(result, {}, theme, { ...context, expanded: true })
				.render(160)
				.join("\n")
				.trimEnd(),
		).toContain("set-entry code/context/sync");
		expect(result.content[0]?.text).toContain(details.reason);
	});

	it("waits for sibling tools before inspecting the repository", async () => {
		const { tools, emit } = harness();
		const tool = tools.get("context_sync");
		if (!tool) throw new Error("context_sync was not registered");
		const execute = tool.execute as (
			id: string,
			params: Record<string, never>,
			signal: undefined,
			onUpdate: undefined,
			ctx: { isProjectTrusted(): boolean },
		) => Promise<unknown>;

		emit("tool_execution_start", { toolCallId: "patch-call", toolName: "patch" });
		emit("tool_execution_start", { toolCallId: "sync-call", toolName: "context_sync" });
		const result = execute("sync-call", {}, undefined, undefined, { isProjectTrusted: () => false });
		let settled = false;
		void result
			.catch(() => undefined)
			.finally(() => {
				settled = true;
			});
		await Promise.resolve();
		expect(settled).toBe(false);

		emit("tool_execution_end", { toolCallId: "patch-call", toolName: "patch" });
		await expect(result).rejects.toThrow("Context sync requires a trusted project");
	});
});
