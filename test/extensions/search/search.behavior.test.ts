import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { pruneSearchContext } from "../../../src/extensions/search/context-pruning.ts";
import { buildAutoReadMessage, buildPathUpdateMessage } from "../../../src/extensions/search/memory-messages.ts";
import { createMutationMemory, evaluateAutoReadEligibility } from "../../../src/extensions/search/mutation-memory.ts";

type AgentMessage = ContextEvent["messages"][number];

describe("search working memory", () => {
	it("current auto read makes older navigation evidence outdated", () => {
		const autoRead = buildAutoReadMessage({ path: "src/foo.ts", content: "export const x = 1;\n", source: "mutation", sourceToolCallId: "p1" });
		const messages: AgentMessage[] = [
			toolResult("g1", "grep", largeText("src/foo.ts:1: x"), { searchEvidence: { version: 1, kind: "grep", role: "navigation", paths: ["src/foo.ts"], complete: true, toolCallId: "g1" } }),
			custom(autoRead.content, autoRead.details),
		];
		const result = pruneSearchContext(messages, "/repo");
		expect(textOf(result.messages[0])).toBe("[outdated]");
		expect(result.statuses.get("g1")).toBe("outdated");
	});

	it("path update makes older evidence outdated", () => {
		const update = buildPathUpdateMessage("p1", [{ kind: "changed", path: "src/foo.ts", autoReadSkipped: "too large" }]);
		const messages: AgentMessage[] = [
			toolResult("r1", "read", largeText("old"), { searchEvidence: { version: 1, kind: "read", role: "current", paths: ["src/foo.ts"], complete: true, toolCallId: "r1" } }),
			custom(update.content, update.details),
		];
		const result = pruneSearchContext(messages, "/repo");
		expect(textOf(result.messages[0])).toBe("[outdated]");
	});

	it("forget marks evidence irrelevant", () => {
		const messages: AgentMessage[] = [
			toolResult("g1", "grep", "src/dead.ts:1: nope", { searchEvidence: { version: 1, kind: "grep", role: "navigation", paths: ["src/dead.ts"], complete: true, toolCallId: "g1" } }),
			toolResult("f1", "forget", "Search memory retained:\nnope", { searchMemory: { version: 1, type: "forget", paths: [{ path: "src/dead.ts" }], disposition: "irrelevant" } }),
		];
		const result = pruneSearchContext(messages, "/repo");
		expect(textOf(result.messages[0])).toBe("[irrelevant]");
	});

	it("mutation messages are sent immediately after patch", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src/foo.ts"), "export const x = 2;\n");
		const memory = createMutationMemory({ getSettings: () => ({ workingMemory: true, excludedPaths: [] }) });
		const messages: AgentMessage[] = [];
		await memory.sendMutationEvidence({ sendMessage(message: AgentMessage) { messages.push(message); } } as never, { source: "patch", toolCallId: "p1", cwd, status: "completed", changes: [{ path: "src/foo.ts", kind: "update", linesAdded: 1, linesRemoved: 1 }] });
		expect(textOf(messages[0])).toContain("auto read src/foo.ts");
	});

	it("excluded and huge mutation has skipped reason", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "dist"));
		await writeFile(join(cwd, "dist/generated.js"), "x");
		expect(await evaluateAutoReadEligibility(cwd, "dist/generated.js", { workingMemory: true, excludedPaths: ["dist"] })).toMatchObject({ ok: false, reason: "noise", path: "dist/generated.js" });
		await writeFile(join(cwd, "big.ts"), "x".repeat(60 * 1024));
		expect(await evaluateAutoReadEligibility(cwd, "big.ts", { workingMemory: true, excludedPaths: [] })).toMatchObject({ ok: false, reason: "too large", path: "big.ts" });
	});
});

function toolResult(id: string, name: string, text: string, details?: unknown): AgentMessage { return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details, isError: false, timestamp: Date.now() } as AgentMessage; }
function custom(content: string, details: unknown): AgentMessage { return { role: "custom", customType: "test", content, display: true, details, timestamp: Date.now() } as AgentMessage; }
function textOf(message: AgentMessage | undefined): string { const record = message as { content?: unknown; output?: unknown } | undefined; if (!record) return ""; if (typeof record.output === "string") return record.output; if (typeof record.content === "string") return record.content; if (!Array.isArray(record.content)) return ""; return record.content.map((block) => (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? block.text : "")).join("\n"); }
function largeText(seed: string): string { return `${seed}\n${"x".repeat(1200)}`; }
async function makeTempDir(): Promise<string> { const path = join(tmpdir(), `search-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`); await mkdir(path, { recursive: true }); return path; }
