import { createEventBus, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runHelper } = vi.hoisted(() => ({ runHelper: vi.fn() }));

vi.mock("../../../extensions/appshot/native-helper.ts", () => ({
	createNativeHelper: () => runHelper,
}));

import appshotExtension from "../../../extensions/appshot/index.ts";

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
}

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: unknown;
	renderCall?: unknown;
	renderResult?: unknown;
}

function harness(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		events: createEventBus(),
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on() {},
	} as unknown as ExtensionAPI;
	appshotExtension(pi);
	return tools;
}

function text(component: Component): string {
	return component.render(160).join("\n").trimEnd();
}

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

afterEach(() => {
	vi.restoreAllMocks();
	runHelper.mockReset();
});

describe("appshot extension", () => {
	it("keeps sequencing and focus rules in native descriptions", () => {
		const tools = harness();
		for (const tool of tools.values()) {
			expect(tool.promptSnippet).toBeUndefined();
			expect(tool.promptGuidelines).toBeUndefined();
		}
		expect(tools.get("list_windows")?.description).toContain("before screenshot_window");
		expect(tools.get("screenshot_window")?.description).toContain("Call list_windows first");
		expect(tools.get("activate_app")?.description).toContain("changes user focus");
	});
	it("returns a flat TOON window table and hides it while collapsed", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		runHelper.mockResolvedValue({
			code: 0,
			stderr: "",
			stdout: JSON.stringify([
				{
					window_id: 7,
					title: "Editor",
					app_name: "Code",
					bundle_id: "com.example.code",
					pid: 42,
					bounds: { x: 1, y: 2, width: 1200, height: 800 },
				},
			]),
		});
		const tool = harness().get("list_windows");
		if (!tool) throw new Error("list_windows was not registered");
		const execute = tool.execute as (
			id: string,
			params: Record<string, never>,
			signal: AbortSignal | undefined,
		) => Promise<ToolResult>;
		const result = await execute("call", {}, undefined);
		expect(result.content[0]?.text).toBe(
			"windows[1]{window_id,title,app_name,bundle_id,pid,x,y,width,height}:\n 7,Editor,Code,com.example.code,42,1,2,1200,800",
		);

		const renderCall = tool.renderCall as (
			args: Record<string, never>,
			theme: Theme,
			context: Record<string, unknown>,
		) => Component;
		const renderResult = tool.renderResult as (
			result: ToolResult,
			options: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			context: Record<string, unknown>,
		) => Component;
		const context = {
			toolCallId: "call",
			invalidate() {},
			lastComponent: undefined,
			expanded: false,
		};
		expect(text(renderCall({}, theme, context))).toBe("list_windows");
		expect(text(renderResult(result, { expanded: false, isPartial: false }, theme, context))).toBe("");
		expect(
			text(
				renderResult(result, { expanded: true, isPartial: false }, theme, {
					...context,
					expanded: true,
				}),
			),
		).toContain("windows[1]");
	});

	it("rejects malformed native window data", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		runHelper.mockResolvedValue({ code: 0, stderr: "", stdout: '[{"window_id":7}]' });
		const tool = harness().get("list_windows");
		if (!tool) throw new Error("list_windows was not registered");
		const execute = tool.execute as (
			id: string,
			params: Record<string, never>,
			signal: AbortSignal | undefined,
		) => Promise<ToolResult>;
		await expect(execute("call", {}, undefined)).rejects.toThrow("Window listing helper returned invalid data");
	});

	it("rejects an oversized PNG before reading it into memory", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const cwd = await mkdtemp(join(tmpdir(), "tau-appshot-test-"));
		try {
			runHelper.mockImplementation(async (args: string[]) => {
				const outputPath = args[2];
				if (!outputPath) throw new Error("capture output path missing");
				await writeFile(outputPath, "");
				await truncate(outputPath, 12 * 1024 * 1024 + 1);
				return { code: 0, stdout: "", stderr: "" };
			});
			const tool = harness().get("screenshot_window");
			if (!tool) throw new Error("screenshot_window was not registered");
			const execute = tool.execute as (
				id: string,
				params: { window_id: number; path: string },
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: ExtensionContext,
			) => Promise<ToolResult>;
			await expect(
				execute("call", { window_id: 7, path: "capture.png" }, undefined, undefined, {
					cwd,
				} as ExtensionContext),
			).rejects.toThrow("12 MiB attachment limit");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
