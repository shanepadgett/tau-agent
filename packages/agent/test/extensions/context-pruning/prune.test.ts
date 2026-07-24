import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { writeFile } from "node:fs/promises";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { executeContextPrune } from "../../../extensions/context-pruning/prune.ts";
import { createWorkspace } from "../explore/helpers.ts";

function result(id: string, name: string, text = "result"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function options(overrides: Partial<Parameters<typeof executeContextPrune>[0]> = {}) {
	const batch = fauxAssistantMessage([
		fauxToolCall("read", { path: "keep.ts" }, { id: "keep" }),
		fauxToolCall("read", { path: "huge.ts" }, { id: "drop" }),
	]);
	const anchor = fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" }));
	const branch = [
		{ type: "message", message: batch },
		{ type: "message", message: result("keep", "read") },
		{ type: "message", message: result("drop", "read", "x".repeat(40_000)) },
		{
			type: "custom_message",
			customType: "tau.autoread",
			content: "old snapshot",
			display: true,
			details: { rowId: "old-autoread" },
		},
		{
			type: "message",
			message: {
				...result("older-anchor", "context_prune"),
				details: { refreshedFiles: [{ rowId: "older-carried" }] },
			},
		},
		{ type: "message", message: anchor },
	] as unknown as SessionEntry[];
	const ctx = {
		cwd: "/tmp",
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
	return {
		branch,
		value: {
			toolCallId: "anchor",
			params: { keepFiles: [], keepToolCalls: [], deferFiles: [] },
			signal: undefined,
			ctx,
			generation: 1,
			currentGeneration: () => 1,
			...overrides,
		},
	};
}

describe("context checkpoint execution", () => {
	it("always applies and records unreserved tool calls and autoreads", async () => {
		const harness = options();
		const execution = await executeContextPrune(harness.value);
		expect(execution.result.details).toEqual({
			v: 2,
			anchorToolCallId: "anchor",
			prunedToolCallIds: ["keep", "drop"],
			prunedAutoreadRowIds: ["old-autoread", "older-carried"],
			retainedToolCallIds: [],
			retainedAutoreadRowIds: [],
			refreshedFiles: [],
			deferredFiles: [],
			warnings: [],
		});
		expect(execution.result.content[0]?.text).toContain("checkpoint applied");
		expect(execution.autoreads).toEqual([]);
	});

	it("retains one call from a parallel batch and harmlessly deduplicates IDs", async () => {
		const harness = options({
			params: {
				keepFiles: [],
				keepToolCalls: [
					{ toolCallId: "keep", relevance: "needed" },
					{ toolCallId: "keep", relevance: "same selection" },
					{ toolCallId: "missing", relevance: "already absent" },
				],
				deferFiles: [],
			},
		});
		const execution = await executeContextPrune(harness.value);
		expect(execution.result.details.retainedToolCallIds).toEqual(["keep", "missing"]);
		expect(execution.result.details.prunedToolCallIds).toEqual(["drop"]);
		expect(execution.result.details.warnings).toEqual([]);
	});

	it("creates fresh snapshots without prior reads and reports per-file failures without blocking", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("current.ts", "export const current = true;\n");
			const harness = options({
				ctx: {
					cwd: workspace.dir,
					sessionManager: { getBranch: () => options().branch },
				} as unknown as ExtensionContext,
				params: {
					keepFiles: [
						{ path: "current.ts", relevance: "active" },
						{ path: "current.ts", relevance: "duplicate" },
						{ path: "missing.ts", relevance: "wanted" },
					],
					keepToolCalls: [],
					deferFiles: [
						{ path: "current.ts", reason: "duplicate", relevantWhen: "never" },
						{ path: "later.ts", reason: "cold", relevantWhen: "fallback fails" },
					],
				},
			});
			const execution = await executeContextPrune(harness.value);
			expect(execution.result.details.refreshedFiles).toHaveLength(1);
			expect(execution.result.details.retainedAutoreadRowIds).toEqual(["anchor:0"]);
			expect(execution.result.details.deferredFiles).toEqual([
				{ path: "later.ts", reason: "cold", relevantWhen: "fallback fails" },
			]);
			expect(execution.result.details.warnings[0]).toContain("missing.ts");
			expect(execution.result.content).toHaveLength(2);
			expect(execution.result.content[1]?.text).toContain("later.ts");
			expect(execution.result.content.some((part) => part.text.includes("export const current"))).toBe(false);
			expect(execution.autoreads).toHaveLength(1);
			expect(execution.autoreads[0]?.content).toContain("current.ts");
		} finally {
			await workspace.cleanup();
		}
	});

	it("continues when one selected file is invalid UTF-8", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("good.ts", "good");
			await writeFile(workspace.path("bad.bin"), Buffer.from([0xc3, 0x28]));
			const base = options();
			const execution = await executeContextPrune({
				...base.value,
				ctx: {
					cwd: workspace.dir,
					sessionManager: { getBranch: () => base.branch },
				} as unknown as ExtensionContext,
				params: {
					keepFiles: [
						{ path: "bad.bin", relevance: "binary" },
						{ path: "good.ts", relevance: "source" },
					],
					keepToolCalls: [],
					deferFiles: [],
				},
			});
			expect(execution.result.details.refreshedFiles.map((file) => file.path)).toEqual(["good.ts"]);
			expect(execution.result.details.warnings).toHaveLength(1);
			expect(execution.result.content).toHaveLength(1);
			expect(execution.autoreads[0]?.content).toContain("good.ts");
		} finally {
			await workspace.cleanup();
		}
	});

	it("only throws for cancellation or a session lifecycle boundary", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(executeContextPrune(options({ signal: controller.signal }).value)).rejects.toMatchObject({
			name: "AbortError",
		});
		await expect(executeContextPrune(options({ generation: 1, currentGeneration: () => 2 }).value)).rejects.toThrow(
			"lifecycle boundary",
		);
	});
});
