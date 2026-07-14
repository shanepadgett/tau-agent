import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../../shared/settings/load.ts", () => ({
	loadTauExtensionSettings: async () => ({ enabled: state.enabled }),
}));

import soulExtension from "../../../extensions/soul/index.ts";

type Handler = (...args: unknown[]) => unknown;

function harness(cwd: string) {
	const handlers = new Map<string, Handler>();
	const activeEntries: unknown[] = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	soulExtension(pi);
	const ctx = {
		cwd,
		isProjectTrusted: () => false,
		sessionManager: {
			buildContextEntries: () => activeEntries,
		},
	} as unknown as ExtensionContext;
	const event = {
		type: "before_agent_start",
		prompt: "test",
		systemPrompt: "Pi base",
		systemPromptOptions: Object.freeze({ cwd, selectedTools: ["read"] }),
	} as BeforeAgentStartEvent;
	return { handlers, activeEntries, ctx, event };
}

afterEach(() => {
	state.enabled = true;
});

describe("Soul composition", () => {
	it("injects hidden runtime facts once while keeping repeated system prompts byte-stable", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-soul-index-"));
		try {
			const { handlers, activeEntries, ctx, event } = harness(cwd);
			await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
			const first = (await handlers.get("before_agent_start")?.(event, ctx)) as BeforeAgentStartEventResult;
			expect(first.systemPrompt).toContain(`Current working directory: ${cwd}`);
			expect(first.systemPrompt).not.toContain("Current local date");
			expect(first.systemPrompt).not.toContain("Root directory snapshot");
			expect(first.message).toMatchObject({ customType: "tau.runtime-context", display: false });
			expect(String(first.message?.content)).toContain("Current local date:");
			activeEntries.push({ type: "custom_message", ...first.message });
			const second = (await handlers.get("before_agent_start")?.(event, ctx)) as BeforeAgentStartEventResult;
			expect(second.systemPrompt).toBe(first.systemPrompt);
			expect(second.message).toBeUndefined();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("preserves Pi's prompt when Soul is disabled and still injects runtime context", async () => {
		state.enabled = false;
		const cwd = await mkdtemp(join(tmpdir(), "tau-soul-index-"));
		try {
			const { handlers, ctx, event } = harness(cwd);
			await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
			const result = (await handlers.get("before_agent_start")?.(event, ctx)) as BeforeAgentStartEventResult;
			expect(result.systemPrompt).toBeUndefined();
			expect(result.message?.customType).toBe("tau.runtime-context");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
