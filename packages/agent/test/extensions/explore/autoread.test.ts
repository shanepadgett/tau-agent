import { createHash } from "node:crypto";
import { createEventBus, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { prepareAutoreadMessage, registerAutoread } from "../../../extensions/explore/autoread.ts";
import { createExploreReadTool } from "../../../extensions/explore/read.ts";
import type { ToolRowStateStore } from "../../../shared/tool-row-state.ts";
import {
	branchExtensionContext,
	createWorkspace,
	executeExploreRead,
	firstText,
	renderedText,
	testRowState,
	testTheme,
} from "./helpers.ts";

function autoreadHarness(): {
	messages: unknown[];
	request(data: unknown, waitForMessage?: boolean): Promise<void>;
	start(): void;
	boundary(name: "session_compact" | "session_tree" | "session_shutdown"): void;
} {
	const messages: unknown[] = [];
	const handlers = new Map<string, Array<() => void>>();
	const pi = {
		events: createEventBus(),
		on(name: string, handler: () => void) {
			const selected = handlers.get(name) ?? [];
			selected.push(handler);
			handlers.set(name, selected);
		},
		sendMessage(message: unknown) {
			messages.push(message);
		},
		registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	registerAutoread(pi, testRowState);
	for (const handler of handlers.get("session_start") ?? []) handler();
	return {
		messages,
		async request(data, waitForMessage = true) {
			const previousCount = messages.length;
			pi.events.emit("tau:autoread.requested", data);
			if (waitForMessage) await vi.waitFor(() => expect(messages.length).toBeGreaterThan(previousCount));
		},
		start() {
			for (const handler of handlers.get("session_start") ?? []) handler();
		},
		boundary(name) {
			for (const handler of handlers.get(name) ?? []) handler();
		},
	};
}

function contextWithMessage(cwd: string, message: unknown) {
	return branchExtensionContext(cwd, [{ type: "custom_message", ...(message as Record<string, unknown>) }]);
}

async function readWithMessage(cwd: string, path: string, message: unknown) {
	return executeExploreRead(contextWithMessage(cwd, message), "read", path);
}

describe("explore autoread", () => {
	it("watches row-state snapshots so existing autoread rows can redraw as pruned", () => {
		let watchedRowId: string | undefined;
		let invalidate: (() => void) | undefined;
		const visualState: { value: "pruned" | undefined } = { value: undefined };
		const rowState: ToolRowStateStore = {
			get: () => visualState.value,
			watch(rowId, callback) {
				watchedRowId = rowId;
				invalidate = callback;
			},
			clear() {},
		};
		type Renderer = (
			message: { details: unknown },
			options: { expanded: boolean },
			theme: Theme,
		) => Component | undefined;
		let renderer: Renderer | undefined;
		const pi = {
			events: createEventBus(),
			on() {},
			registerMessageRenderer(_type: string, candidate: Renderer) {
				renderer = candidate;
			},
		} as unknown as ExtensionAPI;
		registerAutoread(pi, rowState);
		if (!renderer) throw new Error("expected autoread renderer");
		const component = renderer(
			{
				details: {
					rowId: "row",
					path: "file.ts",
					cwd: "/tmp",
					source: "explore",
					batchId: "batch",
					status: "read",
				},
			},
			{ expanded: false },
			testTheme,
		);
		expect(watchedRowId).toBe("row");
		const before = renderedText(component);
		expect(before).toContain("file.ts");
		visualState.value = "pruned";
		if (!invalidate) throw new Error("expected row-state invalidator");
		invalidate();
		const after = renderedText(component);
		expect(after).toContain("file.ts");
		expect(after).not.toBe(before);
	});

	it("prepares a normal autoread message without publishing it", async () => {
		const workspace = await createWorkspace();
		try {
			const source = "first line\nsecond line";
			await workspace.write("file.txt", source);
			const harness = autoreadHarness();
			const message = await prepareAutoreadMessage({
				rowId: "anchor:0",
				path: "file.txt",
				cwd: workspace.dir,
				source: "context-pruning",
				batchId: "anchor",
				signal: undefined,
				isLifecycleCurrent: () => true,
			});

			expect(harness.messages).toEqual([]);
			expect(message).toMatchObject({
				customType: "tau.autoread",
				content: `file.txt\n${source}`,
				display: true,
				details: {
					rowId: "anchor:0",
					path: "file.txt",
					cwd: workspace.dir,
					source: "context-pruning",
					batchId: "anchor",
					status: "read",
					readCache: {
						v: 1,
						scopeKey: "full",
						presentation: "plain",
						mode: "baseline",
						servedHash: createHash("sha256").update(source).digest("hex"),
						totalLines: 2,
						summary: "2 lines",
					},
				},
			});
		} finally {
			await workspace.cleanup();
		}
	});

	it("cancels preparation and rejects stale lifecycle work", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "source");
			const controller = new AbortController();
			controller.abort();
			await expect(
				prepareAutoreadMessage({
					rowId: "abort:0",
					path: "file.txt",
					cwd: workspace.dir,
					source: "context-pruning",
					batchId: "abort",
					signal: controller.signal,
					isLifecycleCurrent: () => true,
				}),
			).rejects.toMatchObject({ name: "AbortError" });
			await expect(
				prepareAutoreadMessage({
					rowId: "stale:0",
					path: "file.txt",
					cwd: workspace.dir,
					source: "context-pruning",
					batchId: "stale",
					signal: undefined,
					isLifecycleCurrent: () => false,
				}),
			).rejects.toThrow("crossed a session lifecycle boundary");
		} finally {
			await workspace.cleanup();
		}
	});

	it("establishes a plain complete-file baseline for unchanged reads and diffs", async () => {
		const workspace = await createWorkspace();
		try {
			const source = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
			await workspace.write("file.txt", source);
			const harness = autoreadHarness();
			await harness.request({
				source: "context",
				cwd: workspace.dir,
				batchId: "batch",
				files: [{ path: "file.txt" }],
			});
			const message = harness.messages[0] as Record<string, unknown>;
			expect(message).toMatchObject({
				customType: "tau.autoread",
				content: `file.txt\n${source}`,
				details: {
					status: "read",
					readCache: { scopeKey: "full", presentation: "plain", totalLines: 100 },
				},
			});

			const tool = createExploreReadTool(testRowState);
			const ctx = contextWithMessage(workspace.dir, message);
			const unchanged = await tool.execute("same", { path: "file.txt" }, undefined, undefined, ctx);
			expect(firstText(unchanged)).toBe("unchanged, 100 lines");
			await workspace.write("file.txt", source.replace("line 50", "line fifty"));
			const changed = await tool.execute("changed", { path: "file.txt" }, undefined, undefined, ctx);
			expect(firstText(changed)).toContain("-line 50");
			expect(firstText(changed)).toContain("+line fifty");
		} finally {
			await workspace.cleanup();
		}
	});

	it("does not establish trust when autoread fails", async () => {
		const workspace = await createWorkspace();
		try {
			const harness = autoreadHarness();
			await harness.request({
				source: "context",
				cwd: workspace.dir,
				batchId: "batch",
				files: [{ path: "missing.txt" }],
			});
			const message = harness.messages[0] as Record<string, unknown>;
			expect(message).toMatchObject({
				customType: "tau.autoread",
				content: expect.stringMatching(/^missing\.txt\nAutoread failed: /),
				display: true,
				details: {
					rowId: "batch:0",
					path: "missing.txt",
					cwd: workspace.dir,
					source: "context",
					batchId: "batch",
					status: "failed",
					error: expect.any(String),
				},
			});
			await workspace.write("missing.txt", "current source");
			const result = await readWithMessage(workspace.dir, "missing.txt", message);
			expect(firstText(result)).toBe("current source");
		} finally {
			await workspace.cleanup();
		}
	});

	it("always sends full current source for an explicit autoread request", async () => {
		const workspace = await createWorkspace();
		try {
			const harness = autoreadHarness();
			await workspace.write("file.txt", "first complete source");
			await harness.request({
				source: "context",
				cwd: workspace.dir,
				batchId: "first",
				files: [{ path: "file.txt" }],
			});
			await workspace.write("file.txt", "second complete source");
			await harness.request({
				source: "context",
				cwd: workspace.dir,
				batchId: "second",
				files: [{ path: "file.txt" }],
			});
			expect(harness.messages).toHaveLength(2);
			expect(harness.messages[0]).toMatchObject({ content: "file.txt\nfirst complete source" });
			expect(harness.messages[1]).toMatchObject({
				content: "file.txt\nsecond complete source",
				details: { readCache: { mode: "baseline" } },
			});
		} finally {
			await workspace.cleanup();
		}
	});

	it("does not publish an autoread that crosses a session boundary", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "source");
			const harness = autoreadHarness();
			await harness.request(
				{
					source: "context",
					cwd: workspace.dir,
					batchId: "stale",
					files: [{ path: "file.txt" }],
				},
				false,
			);
			harness.start();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(harness.messages).toEqual([]);
		} finally {
			await workspace.cleanup();
		}
	});

	it.each(["session_compact", "session_tree", "session_shutdown"] as const)(
		"does not publish stale autoread work after %s",
		async (boundary) => {
			const workspace = await createWorkspace();
			try {
				await workspace.write("file.txt", "source");
				const harness = autoreadHarness();
				await harness.request(
					{
						source: "context",
						cwd: workspace.dir,
						batchId: boundary,
						files: [{ path: "file.txt" }],
					},
					false,
				);
				harness.boundary(boundary);
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(harness.messages).toEqual([]);
			} finally {
				await workspace.cleanup();
			}
		},
	);

	it("rejects a source payload whose path header disagrees with its metadata", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("target.txt", "target source");
			const harness = autoreadHarness();
			await harness.request({
				source: "context",
				cwd: workspace.dir,
				batchId: "path",
				files: [{ path: "target.txt" }],
			});
			const message = structuredClone(harness.messages[0]) as { content: string };
			message.content = "different.txt\ntarget source";
			const result = await readWithMessage(workspace.dir, "target.txt", message);
			expect(firstText(result)).toBe("target source");
		} finally {
			await workspace.cleanup();
		}
	});

	it("uses a UTF-8 BOM autoread as a reconstructible baseline", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("bom.txt", "\uFEFFsource");
			const harness = autoreadHarness();
			await harness.request({
				source: "context",
				cwd: workspace.dir,
				batchId: "bom",
				files: [{ path: "bom.txt" }],
			});
			const result = await readWithMessage(workspace.dir, "bom.txt", harness.messages[0]);
			expect(firstText(result)).toBe("unchanged, 1 lines");
		} finally {
			await workspace.cleanup();
		}
	});
});
