import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import runtimeContextExtension from "../../../extensions/runtime-context/index.ts";

type Handler = (...args: unknown[]) => unknown;

describe("runtime context extension", () => {
	it("adds runtime facts to each agent-start system prompt", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-runtime-context-"));
		try {
			await writeFile(join(cwd, "example.ts"), "export {};\n");
			const handlers = new Map<string, Handler>();
			const pi = {
				on(name: string, handler: Handler) {
					handlers.set(name, handler);
				},
			} as unknown as ExtensionAPI;
			runtimeContextExtension(pi);
			const ctx = {
				cwd,
			} as unknown as ExtensionContext;
			await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
			const first = (await handlers.get("before_agent_start")?.(
				{ systemPrompt: "base" },
				ctx,
			)) as BeforeAgentStartEventResult;
			expect(first.systemPrompt).toContain("base\n\nCurrent local date:");
			expect(first.systemPrompt).toContain("Root directory snapshot (depth 2):");
			const second = (await handlers.get("before_agent_start")?.(
				{ systemPrompt: "base" },
				ctx,
			)) as BeforeAgentStartEventResult;
			expect(second.systemPrompt).toBe(first.systemPrompt);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
