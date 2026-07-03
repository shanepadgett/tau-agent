import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { browseIdeas } from "../extensions/ideas/browser.ts";
import { browseStash } from "../extensions/stash/browser.ts";

export interface DescriptionPromptResult {
	text: string;
	source: "manual" | "idea" | "stash";
}

export async function promptForDescription(ctx: ExtensionCommandContext): Promise<DescriptionPromptResult | null> {
	while (true) {
		const choice = await ctx.ui.select("Description source", [
			"Write description",
			"Pull from ideas",
			"Pull from stash",
		]);
		if (choice === undefined) return null;
		if (choice === "Write description") return { text: "", source: "manual" };
		if (choice === "Pull from ideas") {
			const idea = await browseIdeas(ctx);
			if (idea) return { text: idea.text, source: "idea" };
		} else {
			const stash = await browseStash(ctx);
			if (stash) return { text: stash.text, source: "stash" };
		}
		// Browser cancelled without a pick; loop back to source select.
	}
}
