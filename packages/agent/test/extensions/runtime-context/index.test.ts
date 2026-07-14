import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import runtimeContextExtension from "../../../extensions/runtime-context/index.ts";

type Handler = (...args: unknown[]) => unknown;

describe("runtime context extension", () => {
	it("injects hidden runtime facts once", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-runtime-context-"));
		try {
			const handlers = new Map<string, Handler>();
			const entries: unknown[] = [];
			const pi = {
				on(name: string, handler: Handler) {
					handlers.set(name, handler);
				},
			} as unknown as ExtensionAPI;
			runtimeContextExtension(pi);
			const ctx = {
				cwd,
				sessionManager: { buildContextEntries: () => entries },
			} as unknown as ExtensionContext;
			await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
			const first = (await handlers.get("before_agent_start")?.({}, ctx)) as BeforeAgentStartEventResult;
			expect(first.message).toMatchObject({ customType: "tau.runtime-context", display: false });
			entries.push({ type: "custom_message", ...first.message });
			expect(await handlers.get("before_agent_start")?.({}, ctx)).toBeUndefined();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
