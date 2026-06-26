import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { pruneWorkingMemoryContext } from "../../../src/extensions/working-memory/context-pruning.ts";
import { buildPathUpdateMessage, buildRereadMessage, PATH_UPDATE_CUSTOM_TYPE, REREAD_CUSTOM_TYPE } from "../../../src/extensions/working-memory/memory-messages.ts";
import { createMutationMemory } from "../../../src/extensions/working-memory/mutation-memory.ts";
import { evaluateRereadEligibility } from "../../../src/extensions/working-memory/repo-scope.ts";

type AgentMessage = ContextEvent["messages"][number];

describe("working-memory behavior", () => {
	it("forgets exploratory path evidence with reread condition and keeps checkpoint", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("r1", "read", { path: "src/old.ts" }),
			toolResult("r1", "read", largeText("src/old.ts evidence")),
			assistantToolCall("f1", "forget", { keep: "old.ts irrelevant; keep new.ts", paths: [{ path: "src/old.ts", rereadIf: "changing command registration" }] }),
			toolResult("f1", "forget", "Working memory retained:\nold.ts irrelevant; keep new.ts", { workingMemory: { version: 2, type: "forget", paths: [{ path: "src/old.ts", rereadIf: "changing command registration" }] } }),
		];
		const result = pruneWorkingMemoryContext(messages, "/repo");
		expect(textOf(result.messages[1])).toBe("[forgotten]\nOnly reread if changing command registration.");
		expect(textOf(result.messages[3])).toContain("old.ts irrelevant");
	});

	it("later reread supersedes older read and patch evidence", () => {
		const reread = buildRereadMessage({ path: "src/foo.ts", content: "export const x = 2;\n", source: "mutation", sourceToolCallId: "p1" });
		const messages: AgentMessage[] = [
			assistantToolCall("r1", "read", { path: "src/foo.ts" }),
			toolResult("r1", "read", largeText("export const x = 1;")),
			assistantToolCall("p1", "patch", { input: "*** Begin Patch" }),
			toolResult("p1", "patch", "changed", { status: "completed", changes: [{ path: "src/foo.ts", kind: "update" }] }),
			custom(REREAD_CUSTOM_TYPE, reread.content, reread.details),
		];
		const result = pruneWorkingMemoryContext(messages, "/repo");
		expect(textOf(result.messages[1])).toBe("[superseded]");
		expect(textOf(result.messages[3])).toBe("[superseded]");
	});

	it("later reread supersedes earlier partial read evidence for the same file", () => {
		const reread = buildRereadMessage({ path: "src/foo.ts", content: "export const x = 2;\n", source: "mutation" });
		const messages: AgentMessage[] = [
			assistantToolCall("r1", "read", { path: "src/foo.ts", limit: 90 }),
			toolResult("r1", "read", "partial old evidence"),
			custom(REREAD_CUSTOM_TYPE, reread.content, reread.details),
		];
		const result = pruneWorkingMemoryContext(messages, "/repo");
		expect(textOf(result.messages[1])).toBe("[superseded]");
		expect(result.readStatuses.get("r1")).toBe("superseded");
	});

	it("completed patch alone does not stale reads before reread or path update reconciliation", () => {
		const oldEvidence = largeText("export const x = 1;");
		const messages: AgentMessage[] = [
			assistantToolCall("r1", "read", { path: "src/foo.ts" }),
			toolResult("r1", "read", oldEvidence),
			assistantToolCall("p1", "patch", { input: "*** Begin Patch" }),
			toolResult("p1", "patch", "changed", { status: "completed", changes: [{ path: "src/foo.ts", kind: "update" }] }),
		];
		const result = pruneWorkingMemoryContext(messages, "/repo");
		expect(textOf(result.messages[1])).toBe(oldEvidence);
		expect(textOf(result.messages[3])).toBe("changed");
	});

	it("mutation messages are sent immediately after patch", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src/foo.ts"), "export const x = 2;\n");
		const memory = createMutationMemory({ getSettings: () => ({ excludedPaths: [] }) });
		const messages: AgentMessage[] = [];
		const pi = {
			async sendMessage(message: AgentMessage) {
				messages.push(message);
			},
		};
		await memory.sendMutationEvidence(pi as never, {
			source: "patch",
			toolCallId: "p1",
			cwd,
			status: "completed",
			changes: [{ path: "src/foo.ts", kind: "update", linesAdded: 1, linesRemoved: 1 }],
		});
		expect(textOf(messages[0])).toContain("reread src/foo.ts");
		expect(textOf(messages[0])).toContain("export const x = 2;");
	});

	it("move-only patch is covered by path update, not reread", () => {
		const update = buildPathUpdateMessage("p1", [{ kind: "moved", from: "src/old.ts", to: "src/new.ts" }]);
		const messages: AgentMessage[] = [
			assistantToolCall("p1", "patch", { input: "move only" }),
			toolResult("p1", "patch", "moved", { status: "completed", changes: [{ path: "src/new.ts", kind: "update", move: { from: "src/old.ts", to: "src/new.ts" } }] }),
			custom(PATH_UPDATE_CUSTOM_TYPE, update.content, update.details),
		];
		const result = pruneWorkingMemoryContext(messages, "/repo");
		expect(textOf(result.messages[1])).toBe("[superseded]");
		expect(textOf(result.messages[2])).toContain("moved src/old.ts -> src/new.ts");
	});

	it("excluded and huge mutation has skipped reason, not full content eligibility", async () => {
		const cwd = await makeTempDir();
		await mkdir(join(cwd, "dist"));
		await writeFile(join(cwd, "dist/generated.js"), "x");
		const excluded = await evaluateRereadEligibility(cwd, "dist/generated.js", { excludedPaths: ["dist"] });
		expect(excluded).toMatchObject({ ok: false, reason: "excluded", relativePath: "dist/generated.js" });
		await writeFile(join(cwd, "big.ts"), "x".repeat(60 * 1024));
		const huge = await evaluateRereadEligibility(cwd, "big.ts", { excludedPaths: [] });
		expect(huge).toMatchObject({ ok: false, reason: "too large", relativePath: "big.ts" });
	});

	it("recent forget does not hide failed patch or failed bash", () => {
		const messages: AgentMessage[] = [
			bashExecution("echo ok", "ok", 0),
			bashExecution("false", "bad", 1),
			assistantToolCall("p1", "patch", { input: "bad" }),
			toolResult("p1", "patch", "failed", { status: "failed", changes: [{ path: "src/foo.ts", kind: "update" }] }, true),
			assistantToolCall("f1", "forget", { keep: "cleanup", recent: 5 }),
			toolResult("f1", "forget", "Working memory retained:\ncleanup", { workingMemory: { version: 2, type: "forget", recent: 5 } }),
		];
		const result = pruneWorkingMemoryContext(messages, "/repo");
		expect(textOf(result.messages[0])).toBe("[forgotten]");
		expect(textOf(result.messages[1])).toBe("bad");
		expect(textOf(result.messages[3])).toBe("failed");
	});
});

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AgentMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "tool_use", timestamp: Date.now(), provider: "test", model: "test", api: "test", usage: undefined } as unknown as AgentMessage;
}

function toolResult(id: string, name: string, text: string, details?: unknown, isError = false): AgentMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details, isError, timestamp: Date.now() } as AgentMessage;
}

function custom(customType: string, content: string, details: unknown): AgentMessage {
	return { role: "custom", customType, content, display: true, details, timestamp: Date.now() } as AgentMessage;
}

function bashExecution(command: string, output: string, exitCode: number): AgentMessage {
	return { role: "bashExecution", command, output, exitCode, cancelled: false, truncated: false, timestamp: Date.now() } as AgentMessage;
}

function textOf(message: AgentMessage | undefined): string {
	if (!message) return "";
	const record = message as { content?: unknown; output?: unknown };
	if (typeof record.output === "string") return record.output;
	if (typeof record.content === "string") return record.content;
	if (!Array.isArray(record.content)) return "";
	return record.content.map((block) => (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? block.text : "")).join("\n");
}

function largeText(seed: string): string {
	return `${seed}\n${"x".repeat(1200)}`;
}

async function makeTempDir(): Promise<string> {
	const path = join(tmpdir(), `working-memory-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await mkdir(path, { recursive: true });
	return path;
}
