import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { executeWorkingMemory } from "../../../extensions/working-memory/checkpoint.ts";
import { onTauEvent } from "../../../shared/events.ts";
import { registerOutlineInjectionProvider } from "../../../shared/outline-injection.ts";

function options() {
	const events = createEventBus();
	const pi = {
		events,
		on(name: string, handler: () => void) {
			if (name === "session_start") handler();
		},
	} as unknown as ExtensionAPI;
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "user",
			parentId: null,
			timestamp: "2026-01-01",
			message: { role: "user", content: "important constraint", timestamp: 1 },
		},
		{
			type: "message",
			id: "old-read-call",
			parentId: "user",
			timestamp: "2026-01-01",
			message: fauxAssistantMessage(fauxToolCall("read", { path: "old.ts" }, { id: "old-read" })),
		},
		{
			type: "message",
			id: "old-read-result",
			parentId: "old-read-call",
			timestamp: "2026-01-01",
			message: {
				role: "toolResult",
				toolCallId: "old-read",
				toolName: "read",
				content: [{ type: "text", text: "old source" }],
				isError: false,
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "anchor-entry",
			parentId: "user",
			timestamp: "2026-01-01",
			message: fauxAssistantMessage(fauxToolCall("working_memory", {}, { id: "anchor" })),
		},
	];
	return {
		pi,
		toolCallId: "anchor",
		params: {
			continuation: "Decision is settled. Implement next.",
			keep: ["m:user", "m:missing"],
			readFiles: [],
			outlineFiles: [],
			deferFiles: [{ path: "later.ts", reason: "not active", relevantWhen: "tests fail" }],
		},
		signal: undefined,
		ctx: { cwd: "/tmp", sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext,
		generation: 1,
		currentGeneration: () => 1,
	};
}

describe("working-memory checkpoint", () => {
	it("persists valid refs and returns one canonical continuation", async () => {
		const execution = await executeWorkingMemory(options());
		expect(execution.result.details.retainedRefs).toEqual(["m:user"]);
		expect(execution.result.details.warnings).toEqual([
			"m:missing: memory reference is unavailable and was not retained",
		]);
		expect(execution.result.content[0]?.text.match(/Decision is settled/g)).toHaveLength(1);
		expect(execution.result.content[0]?.text).toContain("## Deferred files");
		expect(execution.result.details.removedUnits).toBe(1);
		expect(execution.outlines).toEqual([]);
	});

	it("aborts across lifecycle boundaries", async () => {
		await expect(executeWorkingMemory({ ...options(), currentGeneration: () => 2 })).rejects.toThrow(
			"lifecycle boundary",
		);
	});

	it("injects outlines separately and lets successful outlines override deferral", async () => {
		const input = options();
		registerOutlineInjectionProvider(input.pi, async (request) => ({
			messages: [
				{
					customType: "tau.explore.outline",
					content: "active.ts\nL1: const active",
					display: true,
					details: {
						v: 1,
						rowId: `${request.batchId}:0`,
						path: "active.ts",
						cwd: request.cwd,
						batchId: request.batchId,
					},
				},
			],
			warnings: [],
		}));
		const execution = await executeWorkingMemory({
			...input,
			params: {
				...input.params,
				outlineFiles: ["active.ts"],
				deferFiles: [{ path: "active.ts", reason: "later", relevantWhen: "blocked" }],
			},
		});
		expect(execution.outlines).toHaveLength(1);
		expect(execution.result.details.outlinedFiles).toEqual([{ path: "active.ts", rowId: "anchor:0" }]);
		expect(execution.result.details.deferredFiles).toEqual([]);
		expect(execution.result.content[0]?.text).not.toContain("L1: const active");
	});

	it("publishes full reads and lets them override outlines and deferral", async () => {
		const input = options();
		const events: unknown[] = [];
		onTauEvent(input.pi, "test.working-memory", "tau:autoread.requested", (event) => {
			events.push(event);
		});
		const execution = await executeWorkingMemory({
			...input,
			params: {
				...input.params,
				readFiles: ["active.ts"],
				outlineFiles: ["active.ts"],
				deferFiles: [{ path: "active.ts", reason: "later", relevantWhen: "blocked" }],
			},
		});
		expect(execution.outlines).toEqual([]);
		expect(execution.result.details.readFiles).toEqual(["active.ts"]);
		expect(execution.result.details.deferredFiles).toEqual([]);
		expect(events).toEqual([
			{
				source: "working_memory",
				title: "Working-memory checkpoint",
				cwd: "/tmp",
				batchId: "anchor",
				files: [{ path: "active.ts" }],
			},
		]);
	});

	it("does not count rows pruned by an earlier checkpoint again", async () => {
		const input = options();
		const branch: SessionEntry[] = [
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: "2026-01-01",
				message: { role: "user", content: "important constraint", timestamp: 1 },
			},
			{
				type: "message",
				id: "old-read-call",
				parentId: "user",
				timestamp: "2026-01-01",
				message: fauxAssistantMessage(fauxToolCall("read", { path: "old.ts" }, { id: "old-read" })),
			},
			{
				type: "message",
				id: "old-read-result",
				parentId: "old-read-call",
				timestamp: "2026-01-01",
				message: {
					role: "toolResult",
					toolCallId: "old-read",
					toolName: "read",
					content: [{ type: "text", text: "old source" }],
					isError: false,
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "previous-anchor-entry",
				parentId: "old-read-result",
				timestamp: "2026-01-01",
				message: fauxAssistantMessage(fauxToolCall("working_memory", {}, { id: "previous-anchor" })),
			},
			{
				type: "message",
				id: "previous-anchor-result",
				parentId: "previous-anchor-entry",
				timestamp: "2026-01-01",
				message: {
					role: "toolResult",
					toolCallId: "previous-anchor",
					toolName: "working_memory",
					content: [{ type: "text", text: "continued" }],
					isError: false,
					timestamp: 1,
					details: {
						v: 2,
						anchorToolCallId: "previous-anchor",
						retainedRefs: ["m:user"],
						retainedLabels: [{ ref: "m:user", label: "user", preview: "important constraint" }],
						prunedRowIds: ["old-read"],
						readFiles: [],
						outlinedFiles: [],
						deferredFiles: [],
						removedUnits: 1,
						warnings: [],
					},
				},
			},
			{
				type: "message",
				id: "anchor-entry",
				parentId: "previous-anchor-result",
				timestamp: "2026-01-01",
				message: fauxAssistantMessage(fauxToolCall("working_memory", {}, { id: "anchor" })),
			},
		];
		const execution = await executeWorkingMemory({
			...input,
			ctx: { cwd: "/tmp", sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext,
		});
		expect(execution.result.details.removedUnits).toBe(0);
	});
});
