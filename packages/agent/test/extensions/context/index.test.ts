import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import contextExtension from "../../../extensions/context/index.ts";
import type { ContextEntry } from "../../../extensions/context/definitions.ts";
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
	messages: unknown[];
	autoreadRequests: unknown[];
	activeTools: string[];
	setActiveTools(names: string[]): void;
	emit: (name: string, event: unknown, ctx?: unknown) => Promise<void>;
} {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const messages: unknown[] = [];
	const autoreadRequests: unknown[] = [];
	let activeTools: string[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void | Promise<void>>>();
	const events = createEventBus();
	events.on("tau:autoread.requested", (event) => autoreadRequests.push(event));
	const pi = {
		events,
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
			if (!activeTools.includes(tool.name)) activeTools = [...activeTools, tool.name];
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		sendMessage(message: unknown) {
			messages.push(message);
		},
		on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
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
		messages,
		autoreadRequests,
		get activeTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		async emit(name, event, ctx = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

describe("context extension", () => {
	it("registers evidence tool without parent prompt surface and keeps commands", async () => {
		const state = harness();
		expect([...state.tools.keys()].sort()).toEqual([CONTEXT_SYNC_EVIDENCE_TOOL]);
		expect(state.tools.get(CONTEXT_SYNC_EVIDENCE_TOOL)?.promptSnippet).toBeUndefined();
		expect(state.tools.has("context_sync")).toBe(false);
		expect(new Set(state.commands.keys())).toEqual(new Set(["context", "context-sync"]));

		// Parent toolset: hide evidence from the coding agent.
		state.setActiveTools(["bash", "read", "subagent", CONTEXT_SYNC_EVIDENCE_TOOL]);
		await state.emit("session_start", {}, { cwd: process.cwd(), isProjectTrusted: () => true });
		expect(state.activeTools).not.toContain(CONTEXT_SYNC_EVIDENCE_TOOL);

		// Context-sync child toolset: keep evidence available with explore tools + bash.
		state.setActiveTools(["read", "ls", "find", "grep", "bash", "patch", CONTEXT_SYNC_EVIDENCE_TOOL]);
		await state.emit("session_start", {}, { cwd: process.cwd(), isProjectTrusted: () => true });
		expect(state.activeTools).toEqual(["read", "ls", "find", "grep", "bash", "patch", CONTEXT_SYNC_EVIDENCE_TOOL]);
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

	it("accepts context-sync nudge args without usage rejection", async () => {
		const { commands } = harness();
		const command = commands.get("context-sync");
		if (!command) throw new Error("context-sync command was not registered");
		const handler = command.handler as (
			args: string,
			ctx: {
				mode: "print";
				cwd: string;
				isProjectTrusted(): boolean;
				waitForIdle(): Promise<void>;
				ui: { notify(message: string, level?: string): void; setStatus(): void };
			},
		) => Promise<void>;
		const notifies: string[] = [];
		await handler("prefer infrastructure domain", {
			mode: "print",
			cwd: process.cwd(),
			isProjectTrusted: () => true,
			waitForIdle: async () => {},
			ui: {
				notify(message) {
					notifies.push(message);
				},
				setStatus() {},
			},
		});
		expect(notifies.join("\n")).toContain("/context-sync requires a trusted TUI project");
		expect(notifies.join("\n")).not.toContain("Usage:");
	});
});
