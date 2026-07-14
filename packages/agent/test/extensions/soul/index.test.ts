import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../../shared/settings/load.ts", () => ({
	loadTauExtensionSettings: async () => ({ enabled: state.enabled }),
}));

import soulExtension from "../../../extensions/soul/index.ts";

type Handler = (...args: unknown[]) => unknown;

function harness() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	soulExtension(pi);
	const ctx = {} as ExtensionContext;
	const event = {
		type: "before_agent_start",
		prompt: "test",
		systemPrompt: "Pi base",
		systemPromptOptions: Object.freeze({ cwd: "/tmp" }),
	} as BeforeAgentStartEvent;
	return { handlers, ctx, event };
}

afterEach(() => {
	state.enabled = true;
});

describe("Soul composition", () => {
	it("appends Rok to Pi's chained prompt", async () => {
		const { handlers, ctx, event } = harness();
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		const result = (await handlers.get("before_agent_start")?.(event, ctx)) as BeforeAgentStartEventResult;
		expect(result.systemPrompt).toMatch(/^Pi base\n\n## Tau persona/);
		expect(result.systemPrompt).toContain("act as Rok");
	});

	it("leaves Pi's prompt untouched when disabled", async () => {
		state.enabled = false;
		const { handlers, ctx, event } = harness();
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		expect(await handlers.get("before_agent_start")?.(event, ctx)).toBeUndefined();
	});
});
