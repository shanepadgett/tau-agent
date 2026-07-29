import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextEntry } from "../../../extensions/context/definitions.ts";
import contextExtension from "../../../extensions/context/index.ts";
import { CONTEXT_PROJECTION_TYPE } from "../../../extensions/context/projection.ts";
import { CONTEXT_SELECTION_TYPE } from "../../../extensions/context/state.ts";
import { CONTEXT_SYNC_EVIDENCE_TOOL } from "../../../extensions/context/evidence.ts";

interface RegisteredTool {
	name: string;
	parameters: { additionalProperties?: boolean; properties?: Record<string, unknown> };
	promptSnippet?: string;
	execute?: unknown;
}

interface RegisteredCommand {
	handler: unknown;
}

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function harness(): {
	tools: Map<string, RegisteredTool>;
	commands: Map<string, RegisteredCommand>;
	entries: SessionEntry[];
	activeTools: string[];
	setActiveTools(names: string[]): void;
	emit(name: string, event: unknown, ctx?: unknown): Promise<unknown>;
} {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const entries: SessionEntry[] = [];
	let activeTools: string[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown | Promise<unknown>>>();
	const pi = {
		events: createEventBus(),
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
			if (!activeTools.includes(tool.name)) activeTools = [...activeTools, tool.name];
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({
				type: "custom",
				id: `entry-${entries.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			});
		},
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		getThinkingLevel() {
			return "medium";
		},
	} as unknown as ExtensionAPI;
	contextExtension(pi);
	return {
		tools,
		commands,
		entries,
		get activeTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		async emit(name, event, ctx = {}) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
			return result;
		},
	};
}

function selectedEntry(root: string): ContextEntry {
	return {
		id: "code/source/runtime",
		tab: "code",
		concept: "source",
		conceptName: "Source",
		conceptDescription: "Source files",
		name: "runtime",
		description: "Runtime source",
		read: ["src/main.ts"],
		outline: [],
		references: ["src/fetch.ts"],
		path: join(root, ".pi", "contexts", "code", "source.toml"),
	};
}

describe("context extension", () => {
	it("registers evidence tool without parent prompt surface and keeps commands", async () => {
		const state = harness();
		expect([...state.tools.keys()].sort()).toEqual([CONTEXT_SYNC_EVIDENCE_TOOL]);
		expect(state.tools.get(CONTEXT_SYNC_EVIDENCE_TOOL)?.promptSnippet).toBeUndefined();
		expect(new Set(state.commands.keys())).toEqual(new Set(["context", "context-sync"]));

		state.setActiveTools(["bash", "read", "subagent", CONTEXT_SYNC_EVIDENCE_TOOL]);
		await state.emit("session_start", {}, { cwd: process.cwd(), isProjectTrusted: () => true });
		expect(state.activeTools).not.toContain(CONTEXT_SYNC_EVIDENCE_TOOL);

		state.setActiveTools(["read", "ls", "find", "grep", "bash", "patch", CONTEXT_SYNC_EVIDENCE_TOOL]);
		await state.emit("session_start", {}, { cwd: process.cwd(), isProjectTrusted: () => true });
		expect(state.activeTools).toEqual(["read", "ls", "find", "grep", "bash", "patch", CONTEXT_SYNC_EVIDENCE_TOOL]);
	});

	it("persists replacement and empty active selections without injecting transcript messages", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-context-index-"));
		roots.push(root);
		await mkdir(join(root, ".pi", "contexts", "code"), { recursive: true });
		await writeFile(
			join(root, ".pi", "contexts", "code", "source.toml"),
			'name = "Source"\n\n[runtime]\ndescription = "Runtime source"\nread = ["src/main.ts"]\noutline = []\nreferences = ["src/fetch.ts"]\n',
		);
		const state = harness();
		const command = state.commands.get("context");
		if (!command) throw new Error("context command was not registered");
		const selections: ContextEntry[][] = [[selectedEntry(root)], []];
		const handler = command.handler as (args: string, ctx: unknown) => Promise<void>;
		const ctx = {
			mode: "tui",
			cwd: root,
			isProjectTrusted: () => true,
			waitForIdle: async () => {},
			sessionManager: { getBranch: () => state.entries },
			ui: { notify() {}, custom: async () => selections.shift() },
		};
		await handler("", ctx);
		await handler("", ctx);

		expect(state.entries.map((entry) => (entry.type === "custom" ? entry.customType : undefined))).toEqual([
			CONTEXT_SELECTION_TYPE,
			CONTEXT_SELECTION_TYPE,
		]);
		expect(state.entries.at(-1)).toMatchObject({ data: { v: 1, entryIds: [] } });
	});

	it("appends one rebuilt ephemeral projection and removes old Context injections", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-context-projection-"));
		roots.push(root);
		await mkdir(join(root, ".pi", "contexts", "code"), { recursive: true });
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "main.ts"), "export const current = true;\n");
		await writeFile(
			join(root, ".pi", "contexts", "code", "source.toml"),
			'name = "Source"\n\n[runtime]\ndescription = "Runtime source"\nread = ["src/main.ts"]\noutline = []\nreferences = ["src/fetch.ts"]\n',
		);
		const state = harness();
		state.entries.push({
			type: "custom",
			id: "selection",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: CONTEXT_SELECTION_TYPE,
			data: { v: 1, entryIds: ["code/source/runtime"] },
		});
		const initialMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "current request" }],
			timestamp: 1,
		};
		const result = (await state.emit(
			"context",
			{
				messages: [
					initialMessage,
					{
						role: "custom",
						customType: "tau.autoread",
						content: "old",
						display: true,
						details: { source: "context" },
						timestamp: 1,
					},
				],
			},
			{
				cwd: root,
				isProjectTrusted: () => true,
				sessionManager: { getBranch: () => state.entries },
				signal: undefined,
			},
		)) as { messages: Array<{ customType?: string; content?: string }> };

		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]).toMatchObject({ role: "user" });
		expect(result.messages[1]?.customType).toBe(CONTEXT_PROJECTION_TYPE);
		expect(result.messages[1]?.content).toContain("export const current = true;");
		expect(result.messages[1]?.content).toContain("- src/fetch.ts");

		await writeFile(join(root, "src", "main.ts"), "export const current = false;\n");
		const next = (await state.emit(
			"context",
			{
				messages: [initialMessage, { role: "user", content: [{ type: "text", text: "follow-up" }], timestamp: 2 }],
			},
			{
				cwd: root,
				isProjectTrusted: () => true,
				sessionManager: { getBranch: () => state.entries },
				signal: undefined,
			},
		)) as { messages: Array<{ customType?: string; content?: string }> };
		expect(next.messages.slice(0, result.messages.length - 1)).toEqual(result.messages.slice(0, -1));
		expect(next.messages.at(-1)?.customType).toBe(CONTEXT_PROJECTION_TYPE);
		expect(next.messages.at(-1)?.content).toContain("export const current = false;");
		expect(state.entries).toHaveLength(1);
	});

	it("accepts context-sync nudge args without usage rejection", async () => {
		const { commands } = harness();
		const command = commands.get("context-sync");
		if (!command) throw new Error("context-sync command was not registered");
		const handler = command.handler as (args: string, ctx: unknown) => Promise<void>;
		const notifies: string[] = [];
		await handler("prefer infrastructure domain", {
			mode: "print",
			cwd: process.cwd(),
			isProjectTrusted: () => true,
			waitForIdle: async () => {},
			ui: {
				notify(message: string) {
					notifies.push(message);
				},
				setWidget() {},
			},
		});
		expect(notifies.join("\n")).toContain("/context-sync requires a trusted TUI project");
		expect(notifies.join("\n")).not.toContain("Usage:");
	});
});
