import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { createTemporaryOutputStore } from "../../../shared/temporary-output-store.ts";
import { prepareFileInjection, registerFileInjection } from "../../../src/file-injection/index.ts";
import { createWorkspace, testRowState } from "../../helpers.ts";

describe("file injection", () => {
	const pi = { events: createEventBus() };

	test("prepares outlines through the runtime provider and detaches it on shutdown", async () => {
		const workspace = await createWorkspace();
		const temporaryOutput = createTemporaryOutputStore();
		const events = createEventBus();
		const startHandlers: Array<() => void> = [];
		const shutdownHandlers: Array<() => void> = [];
		const provider = {
			events,
			on(name: string, handler: () => void) {
				if (name === "session_start") startHandlers.push(handler);
				if (name === "session_shutdown") shutdownHandlers.push(handler);
			},
			registerMessageRenderer() {},
		} as unknown as ExtensionAPI;
		try {
			await workspace.write("source.ts", "export function example(): void {}\n");
			registerFileInjection(provider, testRowState, {
				temporaryOutput,
				autoOutline: () => ({ enabled: true, thresholdLines: 1 }),
			});
			for (const handler of startHandlers) handler();

			const [outlined] = await prepareFileInjection(
				{ events },
				{
					cwd: workspace.dir,
					source: "test",
					batchId: "provider",
					files: [{ path: "source.ts", mode: "outline" }],
				},
			);

			expect(outlined.details).toMatchObject({ kind: "outline", status: "injected" });
			expect(outlined.content).toContain("example");

			for (const handler of shutdownHandlers) handler();
			const [unavailable, full] = await prepareFileInjection(
				{ events },
				{
					cwd: workspace.dir,
					source: "test",
					batchId: "fallback",
					files: [
						{ path: "source.ts", mode: "outline" },
						{ path: "source.ts", mode: "full" },
					],
				},
			);
			expect(unavailable.details).toMatchObject({
				status: "failed",
				error: "File injection is unavailable: Explore is not loaded",
			});
			expect(full.details.status).toBe("injected");
		} finally {
			await temporaryOutput.shutdown();
			await workspace.cleanup();
		}
	});

	test("injects selected line ranges without outlining large sources", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("source.ts", "one\ntwo\nthree\nfour\nfive");

			const [message] = await prepareFileInjection(pi, {
				cwd: workspace.dir,
				source: "test",
				batchId: "batch",
				files: [{ path: "source.ts", mode: "auto", ranges: [{ startLine: 2, endLine: 3 }] }],
			});

			expect(message).toMatchObject({
				content: "source.ts\ntwo\nthree",
				details: {
					kind: "full",
					ranges: [{ startLine: 2, endLine: 3 }],
				},
			});
			expect(message.details.readCache).toBeUndefined();
		} finally {
			await workspace.cleanup();
		}
	});

	test("normalizes overlapping ranges and keeps existing full reads unchanged", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("source.ts", "one\ntwo\nthree\nfour");

			const [ranged, full] = await prepareFileInjection(pi, {
				cwd: workspace.dir,
				source: "test",
				batchId: "batch",
				files: [
					{
						path: "source.ts",
						mode: "full",
						ranges: [
							{ startLine: 3, endLine: 4 },
							{ startLine: 1, endLine: 2 },
							{ startLine: 2, endLine: 3 },
						],
					},
					{ path: "source.ts", mode: "full" },
				],
			});

			expect(ranged.content).toBe("source.ts\none\ntwo\nthree\nfour");
			expect(ranged.details.ranges).toEqual([{ startLine: 1, endLine: 4 }]);
			expect(full.content).toBe("source.ts\none\ntwo\nthree\nfour");
			expect(full.details.ranges).toBeUndefined();
		} finally {
			await workspace.cleanup();
		}
	});

	test("returns a per-file failure for invalid range requests", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("source.ts", "one\ntwo");

			const [message] = await prepareFileInjection(pi, {
				cwd: workspace.dir,
				source: "test",
				batchId: "batch",
				files: [{ path: "source.ts", mode: "outline", ranges: [{ startLine: 2, endLine: 1 }] }],
			});

			expect(message.content).toContain("Line ranges must use positive, ordered line numbers");
			expect(message.details).toMatchObject({ kind: "outline", status: "failed" });
		} finally {
			await workspace.cleanup();
		}
	});

	test("injects a resolved show target without marking the whole file known", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write(
				"source.ts",
				["export function keep(): void {}", "export function target(): number {", "\treturn 1;", "}", ""].join(
					"\n",
				),
			);

			const [message] = await prepareFileInjection(pi, {
				cwd: workspace.dir,
				source: "test",
				batchId: "batch",
				files: [{ path: "source.ts", mode: "show", name: "target" }],
			});

			expect(message.details).toMatchObject({
				kind: "show",
				status: "injected",
				showName: "target",
				showView: "declaration",
				ranges: [{ startLine: 2, endLine: 4 }],
			});
			expect(message.details.readCache).toBeUndefined();
			expect(message.content).toContain("target");
			expect(message.content).toContain("return 1");
			expect(message.content).not.toContain("keep");
		} finally {
			await workspace.cleanup();
		}
	});

	test("returns a per-file failure when a show target does not resolve", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("source.ts", "export function keep(): void {}\n");

			const [message] = await prepareFileInjection(pi, {
				cwd: workspace.dir,
				source: "test",
				batchId: "batch",
				files: [{ path: "source.ts", mode: "show", name: "missing" }],
			});

			expect(message.details).toMatchObject({ kind: "show", status: "failed" });
			expect(message.content).toContain("No declaration matched");
		} finally {
			await workspace.cleanup();
		}
	});
});
