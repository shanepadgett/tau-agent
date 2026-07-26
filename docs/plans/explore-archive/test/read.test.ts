import { createHash } from "node:crypto";
import { symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { generateUnifiedPatch, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createExploreReadTool } from "../../../extensions/explore/read.ts";
import { createOrientationState, sourceFingerprint } from "../../../extensions/explore/orientation-state.ts";
import { createReadSnapshotStore } from "../../../extensions/explore/read-snapshots.ts";
import { matchesExploreReadGate } from "../../../extensions/explore/settings.ts";
import {
	branchExtensionContext,
	createWorkspace,
	executeExploreRead,
	extensionContext,
	firstText,
	renderedText,
	renderContext,
	testOrientation,
	testRowState,
	testTheme,
} from "./helpers.ts";

interface PersistedResult {
	content: unknown;
	details?: unknown;
}

function branchContext(
	cwd: string,
	initial: unknown[] = [],
): {
	ctx: ExtensionContext;
	branch: unknown[];
	appendRead(result: PersistedResult): void;
} {
	const branch = [...initial];
	let readIndex = 0;
	return {
		branch,
		ctx: branchExtensionContext(cwd, branch),
		appendRead(result) {
			readIndex += 1;
			branch.push({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					toolCallId: `read-${readIndex}`,
					content: result.content,
					details: result.details,
				},
			});
		},
	};
}

describe("explore read", () => {
	it("describes ranges and cache behavior without prescribing whole-file-first reads", () => {
		const tool = createExploreReadTool(testRowState, testOrientation);
		expect(tool.description).toContain("optional line ranges");
		expect(tool.description).not.toContain("Read a relevant file as a whole");
		expect(tool.description).not.toContain("Use ranges only");
	});

	it("blocks the first whole-file and ranged reads of supported source", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("src/parser.ts", "export function parse(): void {}\n");
			const orientation = createOrientationState(async () => ["typeScript"]);
			const tool = createExploreReadTool(testRowState, orientation);
			for (const args of [{ path: "src/parser.ts" }, { path: "src/parser.ts", offset: 1, limit: 1 }]) {
				await expect(
					tool.execute("blocked", args, undefined, undefined, extensionContext(workspace.dir)),
				).rejects.toThrow("no current structural attempt");
			}
			expect(orientation.telemetry(undefined).blockedReadAttempts).toBe(2);
		} finally {
			await workspace.cleanup();
		}
	});

	it("matches root and nested gate globs with exclusion precedence", () => {
		const cwd = "/repo";
		const settings = { includeGlobs: ["**/*"], excludeGlobs: ["**/*.md"] };
		expect(matchesExploreReadGate("/repo/main.ts", cwd, settings)).toBe(true);
		expect(matchesExploreReadGate("/repo/README.md", cwd, settings)).toBe(false);
		expect(matchesExploreReadGate("/repo/docs/guide.md", cwd, settings)).toBe(false);
		expect(
			matchesExploreReadGate("/repo/src/generated.ts", cwd, {
				includeGlobs: ["src/**"],
				excludeGlobs: ["src/generated.ts"],
			}),
		).toBe(false);
	});

	it("leaves Markdown ungated by default and allows configuration to gate it", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("README.md", "# Guide\n");
			const orientation = createOrientationState(async () => ["markdown"]);
			const ordinary = createExploreReadTool(testRowState, orientation);
			expect(
				firstText(
					await ordinary.execute(
						"markdown",
						{ path: "README.md" },
						undefined,
						undefined,
						extensionContext(workspace.dir),
					),
				),
			).toBe("# Guide\n");

			const gated = createExploreReadTool(testRowState, orientation, undefined, undefined, () => ({
				includeGlobs: ["**/*"],
				excludeGlobs: [],
			}));
			await expect(
				gated.execute("gated", { path: "README.md" }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow("no current structural attempt");
		} finally {
			await workspace.cleanup();
		}
	});

	it("returns a trusted cached diff after a matching successful patch", async () => {
		const workspace = await createWorkspace();
		try {
			const original = Array.from({ length: 100 }, (_, index) => `// line ${index + 1}`).join("\n");
			const changed = original.replace("// line 50", "// line fifty");
			await workspace.write("src/parser.ts", original);
			const path = workspace.path("src/parser.ts");
			const orientation = createOrientationState(async () => ["typeScript"]);
			orientation.recordAttempts([
				{
					path,
					fingerprint: sourceFingerprint(Buffer.from(original)),
					kind: "directOutline",
					toolCallId: "outline",
					sourceBytesDeflected: 0,
				},
			]);
			const tool = createExploreReadTool(testRowState, orientation);
			const context = branchContext(workspace.dir);
			const baseline = await tool.execute("baseline", { path: "src/parser.ts" }, undefined, undefined, context.ctx);
			context.appendRead(baseline);

			await workspace.write("src/parser.ts", changed);
			orientation.invalidate([path]);
			orientation.recordPatched([{ path, resultingFingerprint: sourceFingerprint(Buffer.from(changed)) }]);
			const result = await tool.execute("patched", { path: "src/parser.ts" }, undefined, undefined, context.ctx);
			expect(firstText(result)).toContain("-// line 50");
			expect(firstText(result)).toContain("+// line fifty");
			expect(result.details?.readCache?.mode).toBe("diff");
			expect(orientation.telemetry(undefined).permissionReadAttempts.postPatchDiff).toBe(1);
		} finally {
			await workspace.cleanup();
		}
	});

	it("rejects patch permits without a complete baseline, for ranges, and after a fingerprint mismatch", async () => {
		const workspace = await createWorkspace();
		try {
			const original = "export const value = 1;\n";
			const changed = "export const value = 2;\n";
			const external = "export const value = 3;\n";
			await workspace.write("src/value.ts", original);
			const path = workspace.path("src/value.ts");
			const orientation = createOrientationState(async () => ["typeScript"]);
			const tool = createExploreReadTool(testRowState, orientation);
			orientation.recordPatched([{ path, resultingFingerprint: sourceFingerprint(Buffer.from(changed)) }]);
			await workspace.write("src/value.ts", changed);
			await expect(
				tool.execute("missing", { path: "src/value.ts" }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow("no current structural attempt");

			orientation.recordAttempts([
				{
					path,
					fingerprint: sourceFingerprint(Buffer.from(changed)),
					kind: "directOutline",
					toolCallId: "outline",
					sourceBytesDeflected: 0,
				},
			]);
			const context = branchContext(workspace.dir);
			const baseline = await tool.execute("baseline", { path: "src/value.ts" }, undefined, undefined, context.ctx);
			context.appendRead(baseline);
			await workspace.write("src/value.ts", external);
			orientation.invalidate([path]);
			orientation.recordPatched([{ path, resultingFingerprint: sourceFingerprint(Buffer.from(external)) }]);
			await expect(
				tool.execute("range", { path: "src/value.ts", offset: 1, limit: 1 }, undefined, undefined, context.ctx),
			).rejects.toThrow("no current structural attempt");

			orientation.recordPatched([{ path, resultingFingerprint: sourceFingerprint(Buffer.from(changed)) }]);
			await expect(
				tool.execute("mismatch", { path: "src/value.ts" }, undefined, undefined, context.ctx),
			).rejects.toThrow("no current structural attempt");
		} finally {
			await workspace.cleanup();
		}
	});

	it("permits the exact fingerprint after a visible filtered outline and rejects siblings or changed source", async () => {
		const workspace = await createWorkspace();
		try {
			const source = "export function parse(): void {}\n";
			await workspace.write("src/parser.ts", source);
			await workspace.write("src/sibling.ts", source);
			const orientation = createOrientationState(async () => ["typeScript"]);
			orientation.recordAttempts([
				{
					path: workspace.path("src/parser.ts"),
					toolCallId: "outline",
					fingerprint: sourceFingerprint(Buffer.from(source)),
					kind: "directOutline",
					sourceBytesDeflected: 10,
				},
			]);
			const tool = createExploreReadTool(testRowState, orientation);
			expect(
				firstText(
					await tool.execute(
						"allowed",
						{ path: "src/parser.ts" },
						undefined,
						undefined,
						extensionContext(workspace.dir),
					),
				),
			).toBe(source);
			await expect(
				tool.execute("sibling", { path: "src/sibling.ts" }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow("no current structural attempt");
			await workspace.write("src/parser.ts", `${source}// changed\n`);
			await expect(
				tool.execute("changed", { path: "src/parser.ts" }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow("no current structural attempt");
		} finally {
			await workspace.cleanup();
		}
	});

	it("gates a symlink by its canonical target language and orientation", async () => {
		const workspace = await createWorkspace();
		try {
			const source = "export function parse(): void {}\n";
			await workspace.write("src/parser.ts", source);
			await symlink("parser.ts", workspace.path("src/parser.txt"));
			const orientation = createOrientationState(async () => ["typeScript"]);
			const tool = createExploreReadTool(testRowState, orientation);
			await expect(
				tool.execute("blocked", { path: "src/parser.txt" }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow("no current structural attempt");
			orientation.recordAttempts([
				{
					path: workspace.path("src/parser.ts"),
					toolCallId: "outline",
					fingerprint: sourceFingerprint(Buffer.from(source)),
					kind: "directOutline",
					sourceBytesDeflected: 0,
				},
			]);
			expect(
				firstText(
					await tool.execute(
						"allowed",
						{ path: "src/parser.txt" },
						undefined,
						undefined,
						extensionContext(workspace.dir),
					),
				),
			).toBe(source);
		} finally {
			await workspace.cleanup();
		}
	});

	it("permits a matching fatal-parser fallback and never strands reads when the worker is unavailable", async () => {
		const workspace = await createWorkspace();
		try {
			const source = "export const broken = ;\n";
			await workspace.write("src/broken.ts", source);
			const fallback = createOrientationState(async () => ["typeScript"]);
			fallback.recordFatal({
				path: workspace.path("src/broken.ts"),
				fingerprint: sourceFingerprint(Buffer.from(source)),
				includePrivate: false,
				names: [],
				code: "outline_failed",
				message: "parser failed",
			});
			const fallbackTool = createExploreReadTool(testRowState, fallback);
			expect(
				firstText(
					await fallbackTool.execute(
						"fallback",
						{ path: "src/broken.ts" },
						undefined,
						undefined,
						extensionContext(workspace.dir),
					),
				),
			).toBe(source);
			expect(fallback.telemetry(undefined).fallbackReadAttempts).toBe(1);

			const unavailable = createOrientationState(async () => {
				throw new Error("worker missing");
			});
			const ordinary = await createExploreReadTool(testRowState, unavailable).execute(
				"unavailable",
				{ path: "src/broken.ts" },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(ordinary)).toBe(source);
		} finally {
			await workspace.cleanup();
		}
	});

	it("delegates plain text, 1-indexed offset, continuation, and truncation", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree\nfour");
			const tool = createExploreReadTool(testRowState, testOrientation);

			const whole = await tool.execute(
				"read",
				{ path: "file.txt" },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(whole)).toBe("one\ntwo\nthree\nfour");

			const range = await tool.execute(
				"read",
				{ path: "@file.txt", offset: 2, limit: 2 },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(range)).toContain("two\nthree");
			expect(firstText(range)).toContain("[1 more lines in file. Use offset=4 to continue.]");

			await workspace.write("large.txt", Array.from({ length: 2105 }, (_, i) => `line ${i + 1}`).join("\n"));
			const large = await tool.execute(
				"read",
				{ path: "large.txt" },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(large)).toContain("[Showing lines 1-2000 of 2105. Use offset=2001 to continue.]");
		} finally {
			await workspace.cleanup();
		}
	});

	it("reports missing, directory, and offset errors", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo");
			await workspace.mkdir("dir");
			const tool = createExploreReadTool(testRowState, testOrientation);
			await expect(
				tool.execute("read", { path: "missing.txt" }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow();
			await expect(
				tool.execute("read", { path: "dir" }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow();
			await expect(
				tool.execute(
					"read",
					{ path: "file.txt", offset: 99 },
					undefined,
					undefined,
					extensionContext(workspace.dir),
				),
			).rejects.toThrow("Offset 99 is beyond end of file");
		} finally {
			await workspace.cleanup();
		}
	});

	it("accepts absolute paths outside cwd", async () => {
		const workspace = await createWorkspace();
		const outside = await createWorkspace();
		try {
			await outside.write("file.txt", "outside");
			const tool = createExploreReadTool(testRowState, testOrientation);
			const result = await tool.execute(
				"read",
				{ path: outside.path("file.txt") },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(result)).toBe("outside");
		} finally {
			await outside.cleanup();
			await workspace.cleanup();
		}
	});

	it("optionally returns source line numbers without duplicating content", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree\nfour");
			const tool = createExploreReadTool(testRowState, testOrientation);
			const result = await tool.execute(
				"read",
				{ path: "file.txt", offset: 2, limit: 2, lineNumbers: true },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(result)).toBe("2: two\n3: three\n\n[1 more lines in file. Use offset=4 to continue.]");
		} finally {
			await workspace.cleanup();
		}
	});

	it("returns a compact marker for an unchanged repeated scope", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree");
			const tool = createExploreReadTool(testRowState, testOrientation);
			const context = branchContext(workspace.dir);
			const first = await tool.execute("first", { path: "file.txt" }, undefined, undefined, context.ctx);
			context.appendRead(first);
			const repeated = await tool.execute("second", { path: "file.txt" }, undefined, undefined, context.ctx);
			expect(firstText(repeated)).toBe("unchanged, 3 lines");
			expect(repeated.details?.readCache?.mode).toBe("unchanged");
		} finally {
			await workspace.cleanup();
		}
	});

	it("returns a useful full-file diff after content changes", async () => {
		const workspace = await createWorkspace();
		try {
			const original = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
			await workspace.write("file.txt", original);
			const tool = createExploreReadTool(testRowState, testOrientation);
			const context = branchContext(workspace.dir);
			const first = await tool.execute("first", { path: "file.txt" }, undefined, undefined, context.ctx);
			context.appendRead(first);
			await workspace.write("file.txt", original.replace("line 50", "line fifty"));
			const changed = await tool.execute("second", { path: "file.txt" }, undefined, undefined, context.ctx);
			expect(firstText(changed)).toContain("[read: 1 lines added, 1 removed of 100]");
			expect(firstText(changed)).toContain("-line 50");
			expect(firstText(changed)).toContain("+line fifty");
			expect(changed.details?.readCache?.mode).toBe("diff");
		} finally {
			await workspace.cleanup();
		}
	});

	it("shares complete-file authority across plain and line-numbered presentations", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree");
			const tool = createExploreReadTool(testRowState, testOrientation);
			const context = branchContext(workspace.dir);
			const numbered = await tool.execute(
				"numbered",
				{ path: "file.txt", lineNumbers: true },
				undefined,
				undefined,
				context.ctx,
			);
			expect(firstText(numbered)).toBe("1: one\n2: two\n3: three");
			context.appendRead(numbered);
			const plain = await tool.execute("plain", { path: "file.txt" }, undefined, undefined, context.ctx);
			expect(firstText(plain)).toBe("unchanged, 3 lines");
		} finally {
			await workspace.cleanup();
		}
	});

	it("uses a line-numbered subagent autoread as a complete-file baseline", async () => {
		const workspace = await createWorkspace();
		try {
			const source = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
			await workspace.write("file.txt", source);
			const hash = createHash("sha256").update(source).digest("hex");
			const pathKey = resolve(workspace.dir, "file.txt");
			const numbered = source
				.split("\n")
				.map((line, index) => `${index + 1}: ${line}`)
				.join("\n");
			const context = branchContext(workspace.dir, [
				{
					type: "custom_message",
					customType: "tau.autoread",
					content: `file.txt\n${numbered}`,
					details: {
						rowId: "autoread:numbered",
						path: "file.txt",
						cwd: workspace.dir,
						status: "read",
						readCache: {
							v: 1,
							pathKey,
							scopeKey: "full",
							presentation: "line-numbered",
							servedHash: hash,
							mode: "baseline",
							baselineTokens: 1,
							returnedTokens: 1,
							totalLines: 100,
							summary: "100 lines",
						},
					},
				},
			]);
			const tool = createExploreReadTool(testRowState, testOrientation);
			const unchanged = await tool.execute("same", { path: "file.txt" }, undefined, undefined, context.ctx);
			expect(firstText(unchanged)).toBe("unchanged, 100 lines");
			await workspace.write("file.txt", source.replace("line 50", "line fifty"));
			const changed = await tool.execute("changed", { path: "file.txt" }, undefined, undefined, context.ctx);
			expect(firstText(changed)).toContain("-line 50");
			expect(firstText(changed)).toContain("+line fifty");
		} finally {
			await workspace.cleanup();
		}
	});

	it("reconstructs a missing snapshot after an unchanged read", async () => {
		const workspace = await createWorkspace();
		try {
			const baselineText = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
			const currentText = baselineText.replace("line 50", "line fifty");
			const baselineHash = createHash("sha256").update(baselineText).digest("hex");
			const currentHash = createHash("sha256").update(currentText).digest("hex");
			const pathKey = resolve(workspace.dir, "file.txt");
			await workspace.write("file.txt", currentText);
			const snapshots = createReadSnapshotStore();
			const tool = createExploreReadTool(testRowState, testOrientation, undefined, snapshots);
			const common = {
				v: 1,
				pathKey,
				scopeKey: "full",
				presentation: "plain",
				baselineTokens: 1,
				returnedTokens: 1,
				totalLines: 100,
				summary: "100 lines",
			};
			const context = branchContext(workspace.dir, [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "read",
						toolCallId: "baseline",
						content: [{ type: "text", text: baselineText }],
						details: { readCache: { ...common, servedHash: baselineHash, mode: "baseline" } },
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "read",
						toolCallId: "diff",
						content: [
							{
								type: "text",
								text: `[read: 1 lines added, 1 removed of 100]\n${generateUnifiedPatch("file.txt", baselineText, currentText, 3)}`,
							},
						],
						details: {
							readCache: {
								...common,
								servedHash: currentHash,
								baseHash: baselineHash,
								mode: "diff",
							},
						},
					},
				},
			]);
			const nextText = currentText.replace("line fifty", "changed");
			await workspace.write("file.txt", nextText);
			const restarted = await executeExploreRead(context.ctx, "restart", "file.txt");
			expect(firstText(restarted)).toContain("-line fifty");
			expect(firstText(restarted)).toContain("+changed");
			expect(restarted.details?.readCache?.mode).toBe("diff");
			await workspace.write("file.txt", currentText);
			const unchanged = await tool.execute("same", { path: "file.txt" }, undefined, undefined, context.ctx);
			expect(firstText(unchanged)).toBe("unchanged, 100 lines");
			context.appendRead(unchanged);
			await workspace.write("file.txt", nextText);
			const changed = await tool.execute("changed", { path: "file.txt" }, undefined, undefined, context.ctx);
			expect(firstText(changed)).toContain("-line fifty");
			expect(firstText(changed)).toContain("+changed");
		} finally {
			await workspace.cleanup();
		}
	});

	it("does not recover complete-file trust across a compaction boundary", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree");
			const tool = createExploreReadTool(testRowState, testOrientation);
			const context = branchContext(workspace.dir);
			const baseline = await tool.execute("seed", { path: "file.txt" }, undefined, undefined, context.ctx);
			context.appendRead(baseline);
			context.branch.push({ type: "compaction" });
			const result = await tool.execute("after", { path: "file.txt" }, undefined, undefined, context.ctx);
			expect(firstText(result)).toBe("one\ntwo\nthree");
			expect(result.details?.readCache?.mode).toBe("baseline");
		} finally {
			await workspace.cleanup();
		}
	});

	it("falls back to current source for malformed source-bearing metadata", async () => {
		const workspace = await createWorkspace();
		try {
			const source = "one\ntwo\nthree";
			await workspace.write("file.txt", source);
			const context = branchContext(workspace.dir, [
				{
					type: "message",
					message: {
						customType: "tau.autoread",
						content: "file.txt\n1: one\nnot reversible",
						details: {
							rowId: "autoread:malformed",
							status: "read",
							readCache: {
								v: 1,
								pathKey: resolve(workspace.dir, "file.txt"),
								scopeKey: "full",
								presentation: "line-numbered",
								servedHash: createHash("sha256").update(source).digest("hex"),
								mode: "baseline",
								baselineTokens: 1,
								returnedTokens: 1,
								totalLines: 3,
								summary: "3 lines",
							},
						},
					},
				},
			]);
			const result = await executeExploreRead(context.ctx, "read", "file.txt");
			expect(firstText(result)).toBe(source);
		} finally {
			await workspace.cleanup();
		}
	});

	it("rejects stale and oversized snapshot writes", () => {
		const snapshots = createReadSnapshotStore();
		const staleEpoch = snapshots.epoch();
		snapshots.clear();
		expect(snapshots.set("stale", "source", 6, staleEpoch)).toBe(false);
		expect(snapshots.get("stale")).toBeUndefined();
		const currentEpoch = snapshots.epoch();
		expect(snapshots.set("large", "source", 1024 * 1024 + 1, currentEpoch)).toBe(false);
		expect(snapshots.get("large")).toBeUndefined();
	});

	it("returns every line for overlapping ranges and after any file change", async () => {
		const workspace = await createWorkspace();
		try {
			const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
			await workspace.write("file.txt", original);
			const tool = createExploreReadTool(testRowState, testOrientation);
			const ctx = extensionContext(workspace.dir);
			await tool.execute("first", { path: "file.txt", offset: 10, limit: 5 }, undefined, undefined, ctx);

			const overlap = await tool.execute(
				"overlap",
				{ path: "file.txt", offset: 12, limit: 5 },
				undefined,
				undefined,
				ctx,
			);
			expect(firstText(overlap)).toContain("line 12\nline 13\nline 14\nline 15\nline 16");

			await workspace.write("file.txt", original.replace("line 1", "changed elsewhere"));
			const changed = await tool.execute(
				"changed",
				{ path: "file.txt", offset: 10, limit: 5 },
				undefined,
				undefined,
				ctx,
			);
			expect(firstText(changed)).toContain("line 10\nline 11\nline 12\nline 13\nline 14");
			expect(changed.details?.readCache?.mode).toBe("baseline");
		} finally {
			await workspace.cleanup();
		}
	});

	it("returns normal content after a failed patch for the same path", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree");
			const tool = createExploreReadTool(testRowState, testOrientation);
			const ctx = {
				...extensionContext(workspace.dir),
				sessionManager: {
					getBranch() {
						return [
							{
								type: "message",
								message: {
									role: "toolResult",
									toolName: "patch",
									details: {
										status: "failed",
										failures: [{ path: "file.txt", message: "could not match" }],
									},
								},
							},
						];
					},
					buildContextEntries() {
						return this.getBranch();
					},
					getSessionId() {
						return "session";
					},
					getLeafId() {
						return "leaf";
					},
				},
			} as unknown as ExtensionContext;
			const result = await tool.execute("read", { path: "file.txt" }, undefined, undefined, ctx);
			expect(firstText(result)).toBe("one\ntwo\nthree");
			expect(result.details?.readCache?.mode).toBe("recovery");
		} finally {
			await workspace.cleanup();
		}
	});

	it("renders collapsed errors as a summarized row and expanded errors with body", () => {
		const tool = createExploreReadTool(testRowState, testOrientation);
		const result = {
			content: [{ type: "text" as const, text: "Offset 99 is beyond end of file" }],
			details: undefined,
		};
		const collapsed = renderedText(
			tool.renderResult?.(
				result,
				{ expanded: false, isPartial: false },
				testTheme,
				renderContext({ path: "file.txt" }, false, true),
			),
		);
		expect(collapsed).toContain("file.txt");
		expect(collapsed).toContain("error");
		expect(
			renderedText(
				tool.renderResult?.(
					result,
					{ expanded: true, isPartial: false },
					testTheme,
					renderContext({ path: "file.txt" }, true, true),
				),
			),
		).toContain("Offset 99 is beyond end of file");
	});

	it("hides the completed call renderer after reload", () => {
		const tool = createExploreReadTool(testRowState, testOrientation);
		const context = {
			...renderContext({ path: "file.txt" }, false),
			executionStarted: false,
		};
		expect(renderedText(tool.renderCall?.({ path: "file.txt" }, testTheme, context))).toBe("");
	});
});
