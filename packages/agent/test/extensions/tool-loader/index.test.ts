import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
	wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import toolLoaderExtension from "../../../extensions/tool-loader/index.ts";

const specialists = [
	"webfetch",
	"websearch",
	"codesearch",
	"image_gen",
	"list_windows",
	"screenshot_window",
	"activate_app",
];
type Handler = (...args: unknown[]) => unknown;
interface LoaderTool {
	name: string;
	parameters: unknown;
	execute: (
		id: string,
		params: { capability: "web" | "image" | "appshot" },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
	) => Promise<{ details: unknown; addedToolNames?: string[] }>;
}

function harness(initial: string[]) {
	let active = [...initial];
	let loader: LoaderTool | undefined;
	const handlers = new Map<string, Handler>();
	const all = [...new Set([...initial, ...specialists])].map((name) => ({ name }));
	const pi = {
		events: createEventBus(),
		registerTool(tool: LoaderTool) {
			loader = tool;
			if (!all.some((item) => item.name === tool.name)) all.push({ name: tool.name });
		},
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		getActiveTools: () => [...active],
		getAllTools: () => all,
		setActiveTools(names: string[]) {
			active = names.filter((name) => all.some((item) => item.name === name));
		},
	} as unknown as ExtensionAPI;
	toolLoaderExtension(pi);
	if (!loader) throw new Error("load_tools was not registered");
	return { pi, loader, handlers, active: () => active };
}

function context(branch: readonly unknown[] = []): ExtensionContext {
	return { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
}

function resultEntry(capability: "web" | "image" | "appshot") {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "load_tools",
			isError: false,
			details: { version: 1, capability, requestedToolNames: [], addedToolNames: [] },
		},
	};
}

describe("load_tools", () => {
	it("registers a strict fixed-capability schema", () => {
		const { loader } = harness(["load_tools", ...specialists]);
		const schema = loader.parameters as {
			required?: string[];
			additionalProperties?: boolean;
			properties?: { capability?: { enum?: string[] } };
		};
		expect(loader.name).toBe("load_tools");
		expect(schema.required).toEqual(["capability"]);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties?.capability?.enum).toEqual(["web", "image", "appshot"]);
	});

	it("hides specialists in normal sessions, then purely appends requested groups", async () => {
		const h = harness(["read", "bash", "load_tools", ...specialists]);
		await h.handlers.get("session_start")?.({ type: "session_start" }, context());
		expect(h.active()).toEqual(["read", "bash", "load_tools"]);
		const result = await h.loader.execute("call", { capability: "web" }, undefined, undefined);
		expect(h.active()).toEqual(["read", "bash", "load_tools", "webfetch", "websearch", "codesearch"]);
		expect(result.details).toMatchObject({ capability: "web", addedToolNames: specialists.slice(0, 3) });
		expect(result).not.toHaveProperty("addedToolNames");
	});

	it("never exposes tools excluded by a constrained initial configuration", async () => {
		const h = harness(["read", "load_tools", "webfetch", "websearch"]);
		await h.handlers.get("session_start")?.({ type: "session_start" }, context());
		await h.loader.execute("call", { capability: "web" }, undefined, undefined);
		expect(h.active()).toEqual(["read", "load_tools", "webfetch", "websearch"]);
		expect(h.active()).not.toContain("codesearch");
	});

	it("restores branch state in canonical order on start and tree navigation", async () => {
		const h = harness(["read", "load_tools", ...specialists]);
		await h.handlers.get("session_start")?.({ type: "session_start" }, context([resultEntry("image")]));
		expect(h.active()).toEqual(["read", "load_tools", "image_gen"]);
		await h.handlers.get("session_tree")?.({ type: "session_tree" }, context([resultEntry("web")]));
		expect(h.active()).toEqual(["read", "load_tools", "webfetch", "websearch", "codesearch"]);
	});

	it("serializes parallel loads without losing either group", async () => {
		const h = harness(["read", "load_tools", ...specialists]);
		await h.handlers.get("session_start")?.({ type: "session_start" }, context());
		await Promise.all([
			h.loader.execute("web", { capability: "web" }, undefined, undefined),
			h.loader.execute("image", { capability: "image" }, undefined, undefined),
		]);
		expect(h.active()).toEqual(["read", "load_tools", "webfetch", "websearch", "codesearch", "image_gen"]);
	});

	it("receives Pi's real top-level cache annotation for pure additions", async () => {
		const h = harness(["read", "load_tools", ...specialists]);
		await h.handlers.get("session_start")?.({ type: "session_start" }, context());
		const runner = {
			getActiveTools: h.pi.getActiveTools,
			createContext: () => context(),
		} as never;
		const wrapped = wrapRegisteredTool(
			{
				definition: h.loader as never,
				sourceInfo: { path: "tool-loader/index.ts", source: "test", scope: "temporary", origin: "top-level" },
			},
			runner,
		);
		const result = await wrapped.execute("call", { capability: "image" }, undefined, undefined);
		expect(result.addedToolNames).toEqual(["image_gen"]);
	});
});
