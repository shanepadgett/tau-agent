import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectTauSystemPromptContributions,
	registerTauSystemPromptContribution,
} from "../../shared/system-prompt-contributions.ts";

const event = {
	type: "before_agent_start",
	prompt: "test",
	systemPrompt: "base",
	systemPromptOptions: Object.freeze({ cwd: "/tmp" }),
} as BeforeAgentStartEvent;
const ctx = {} as ExtensionContext;
const cleanup: Array<() => void> = [];

afterEach(() => {
	for (const unsubscribe of cleanup.splice(0)) unsubscribe();
});

function register(
	id: string,
	order: number,
	render: () => string | undefined | Promise<string | undefined>,
): () => void {
	const unsubscribe = registerTauSystemPromptContribution({ id, order, render });
	cleanup.push(unsubscribe);
	return unsubscribe;
}

describe("Tau system prompt contributions", () => {
	it("sorts by order then id, trims blocks, and deduplicates exact text", async () => {
		register("test.z", 20, () => " same ");
		register("test.b", 10, () => "second");
		register("test.a", 10, () => "first");
		register("test.empty", 30, () => "  ");
		register("test.duplicate", 40, () => "same");
		expect(await collectTauSystemPromptContributions(event, ctx)).toEqual(["first", "second", "same"]);
	});

	it("retains canonical order when async callbacks finish out of order", async () => {
		register("test.slow", 1, async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return "slow";
		});
		register("test.fast", 2, async () => "fast");
		expect(await collectTauSystemPromptContributions(event, ctx)).toEqual(["slow", "fast"]);
	});

	it("replacement is token-owned and repeated collection leaves frozen input unchanged", async () => {
		const oldUnsubscribe = register("test.replace", 1, () => "old");
		register("test.replace", 1, () => "new");
		oldUnsubscribe();
		expect(await collectTauSystemPromptContributions(event, ctx)).toEqual(["new"]);
		expect(await collectTauSystemPromptContributions(event, ctx)).toEqual(["new"]);
		expect(event.systemPromptOptions).toEqual({ cwd: "/tmp" });
	});
});
