import { fauxAssistantMessage, fauxText, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { symlink, writeFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { executeContextPrune } from "../../../extensions/context-pruning/prune.ts";
import { prepareAutoreadMessage } from "../../../extensions/explore/autoread.ts";
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

function context(anchor: ReturnType<typeof fauxAssistantMessage>, cwd = "/tmp"): ExtensionContext {
	const branch = [{ type: "message", message: anchor }];
	return {
		cwd,
		sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
	} as unknown as ExtensionContext;
}

function options(overrides: Partial<Parameters<typeof executeContextPrune>[0]> = {}) {
	const anchor = fauxAssistantMessage([
		fauxText("The retained conclusion is durable. Next I will implement it."),
		fauxToolCall("context_prune", {}, { id: "anchor" }),
	]);
	const old = fauxAssistantMessage(fauxToolCall("grep", { query: "noise" }, { id: "old" }));
	const sendMessage = vi.fn();
	return {
		anchor,
		sendMessage,
		value: {
			pi: { sendMessage },
			toolCallId: "anchor",
			params: { keepFiles: [], keepToolCalls: [], deferFiles: [] },
			signal: undefined,
			ctx: context(anchor),
			projection: { generation: 1, messages: [old, result("old", "grep", "x".repeat(40_000))] },
			currentGeneration: () => 1,
			currentEnabled: () => true,
			minimumReclaimTokens: 1,
			...overrides,
		},
	};
}

describe("context prune planning", () => {
	it("applies a deterministic prune and publishes deferred context only at commit", async () => {
		const harness = options({
			params: {
				keepFiles: [],
				keepToolCalls: [],
				deferFiles: [{ path: "later.ts", reason: "cold", relevantWhen: "the fallback fails" }],
			},
		});
		const execution = await executeContextPrune(harness.value);
		expect(execution.details).toMatchObject({
			status: "applied",
			anchorToolCallId: "anchor",
			newlyPrunedToolCallIds: ["old"],
			newlyPrunedAutoreadRowIds: [],
			deferredFiles: [{ path: "later.ts", reason: "cold", relevantWhen: "the fallback fails" }],
		});
		expect(execution.details.tokensReclaimed).toBeGreaterThan(0);
		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "tau.context-pruning.deferred", display: false }),
			{ deliverAs: "steer" },
		);
	});

	it("rejects sibling calls and unknown retained exchanges without side effects", async () => {
		const siblingAnchor = fauxAssistantMessage([
			fauxToolCall("context_prune", {}, { id: "anchor" }),
			fauxToolCall("read", { path: "x" }, { id: "sibling" }),
		]);
		const sibling = options({ ctx: context(siblingAnchor) });
		const siblingResult = await executeContextPrune(sibling.value);
		expect(siblingResult.details.status).toBe("skipped");
		expect(siblingResult.content[0]?.text).toContain("only tool call");
		expect(sibling.sendMessage).not.toHaveBeenCalled();

		const unknown = options({
			params: {
				keepFiles: [],
				keepToolCalls: [{ toolCallId: "missing", relevance: "needed" }],
				deferFiles: [],
			},
		});
		const unknownResult = await executeContextPrune(unknown.value);
		expect(unknownResult.details.status).toBe("skipped");
		expect(unknownResult.content[0]?.text).toContain("complete currently projected exchange");
		expect(unknown.sendMessage).not.toHaveBeenCalled();
	});

	it("keeps exact exchanges and returns an atomic no-op below threshold", async () => {
		const harness = options({
			params: {
				keepFiles: [],
				keepToolCalls: [{ toolCallId: "old", relevance: "chronology matters" }],
				deferFiles: [],
			},
			minimumReclaimTokens: 8_000,
		});
		const execution = await executeContextPrune(harness.value);
		expect(execution.details.status).toBe("skipped");
		expect(execution.details.newlyPrunedToolCallIds).toEqual([]);
		expect(execution.content[0]?.text).toContain("without immediately retrying");
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("throws on pre-commit cancellation without publishing", async () => {
		const controller = new AbortController();
		controller.abort();
		const harness = options({ signal: controller.signal });
		await expect(executeContextPrune(harness.value)).rejects.toMatchObject({ name: "AbortError" });
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("rejects canonical duplicate selections and incomplete projected exchanges", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("real.ts", "source");
			await symlink(workspace.path("real.ts"), workspace.path("alias.ts"));
			const duplicate = options({
				ctx: context(options().anchor, workspace.dir),
				params: {
					keepFiles: [{ path: "real.ts", relevance: "active" }],
					keepToolCalls: [],
					deferFiles: [{ path: "alias.ts", reason: "cold", relevantWhen: "fallback" }],
				},
			});
			const duplicateResult = await executeContextPrune(duplicate.value);
			expect(duplicateResult.details.status).toBe("skipped");
			expect(duplicateResult.content[0]?.text).toContain("Duplicate file selection");
			expect(duplicate.sendMessage).not.toHaveBeenCalled();

			const incompleteCall = fauxAssistantMessage(fauxToolCall("grep", {}, { id: "incomplete" }));
			const incomplete = options({ projection: { generation: 1, messages: [incompleteCall] } });
			const incompleteResult = await executeContextPrune(incomplete.value);
			expect(incompleteResult.details.status).toBe("skipped");
			expect(incompleteResult.content[0]?.text).toContain("Incomplete projected tool exchange");
			expect(incomplete.sendMessage).not.toHaveBeenCalled();
		} finally {
			await workspace.cleanup();
		}
	});

	it("publishes nothing when a later file refresh fails after an earlier refresh prepared", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("first.ts", "old first");
			await workspace.write("second.ts", "old second");
			const first = await prepareAutoreadMessage({
				rowId: "first",
				path: "first.ts",
				cwd: workspace.dir,
				source: "explore",
				batchId: "reads",
				signal: undefined,
				isLifecycleCurrent: () => true,
			});
			const second = await prepareAutoreadMessage({
				rowId: "second",
				path: "second.ts",
				cwd: workspace.dir,
				source: "explore",
				batchId: "reads",
				signal: undefined,
				isLifecycleCurrent: () => true,
			});
			await workspace.write("first.ts", "new first");
			await writeFile(workspace.path("second.ts"), Buffer.from([0xc3, 0x28]));
			const anchor = options().anchor;
			const harness = options({
				ctx: context(anchor, workspace.dir),
				params: {
					keepFiles: [
						{ path: "first.ts", relevance: "active" },
						{ path: "second.ts", relevance: "active" },
					],
					keepToolCalls: [],
					deferFiles: [],
				},
				projection: {
					generation: 1,
					messages: [
						{ role: "custom", ...first, timestamp: 1 },
						{ role: "custom", ...second, timestamp: 1 },
						fauxAssistantMessage(fauxToolCall("grep", {}, { id: "noise" })),
						result("noise", "grep", "x".repeat(40_000)),
					],
				},
			});
			const execution = await executeContextPrune(harness.value);
			expect(execution.details.status).toBe("skipped");
			expect(harness.sendMessage).not.toHaveBeenCalled();
		} finally {
			await workspace.cleanup();
		}
	});

	it("propagates commit publication failures instead of returning skipped details", async () => {
		const firstFailure = options({
			params: {
				keepFiles: [],
				keepToolCalls: [],
				deferFiles: [{ path: "later.ts", reason: "cold", relevantWhen: "fallback" }],
			},
		});
		firstFailure.sendMessage.mockImplementation(() => {
			throw new Error("enqueue failed");
		});
		await expect(executeContextPrune(firstFailure.value)).rejects.toThrow("enqueue failed");

		const workspace = await createWorkspace();
		try {
			await workspace.write("file.ts", "old");
			const baseline = await prepareAutoreadMessage({
				rowId: "baseline",
				path: "file.ts",
				cwd: workspace.dir,
				source: "explore",
				batchId: "reads",
				signal: undefined,
				isLifecycleCurrent: () => true,
			});
			await workspace.write("file.ts", "new");
			const anchor = options().anchor;
			const secondFailure = options({
				ctx: context(anchor, workspace.dir),
				params: {
					keepFiles: [{ path: "file.ts", relevance: "active" }],
					keepToolCalls: [],
					deferFiles: [{ path: "later.ts", reason: "cold", relevantWhen: "fallback" }],
				},
				projection: {
					generation: 1,
					messages: [
						{ role: "custom", ...baseline, timestamp: 1 },
						fauxAssistantMessage(fauxToolCall("grep", {}, { id: "noise" })),
						result("noise", "grep", "x".repeat(40_000)),
					],
				},
			});
			secondFailure.sendMessage
				.mockImplementationOnce(() => undefined)
				.mockImplementationOnce(() => {
					throw new Error("second enqueue failed");
				});
			await expect(executeContextPrune(secondFailure.value)).rejects.toThrow("second enqueue failed");
			expect(secondFailure.sendMessage).toHaveBeenCalledTimes(2);
		} finally {
			await workspace.cleanup();
		}
	});
});
