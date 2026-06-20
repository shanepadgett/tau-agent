import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { browseIdeas } from "../extensions/ideas/browser.ts";
import { browseStash } from "../extensions/stash/browser.ts";

/**
 * Prompt for a description in the native editor, with an option to prefill
 * from the ideas or stash store. Chosen text lands in the editor as editable text
 * before submit, so it can be shaped into the request.
 *
 * The native editor modal exposes no custom-key hook, so source selection
 * (write vs. pull from ideas/stash) happens in a select step before the editor,
 * and the idea text is passed as the editor's prefill.
 *
 * Returns the trimmed description, or null if the user cancelled at any step.
 */
export interface DescriptionPromptResult {
	text: string;
	source: "manual" | "idea" | "stash";
}

export async function promptForDescription(
	ctx: ExtensionCommandContext,
	title: string,
	requiredTitle: string,
): Promise<DescriptionPromptResult | null> {
	const prefill = await choosePrefill(ctx);
	if (prefill === null) return null;

	let currentTitle = title;
	let current = prefill.text;
	while (true) {
		const value = await ctx.ui.editor(currentTitle, current);
		if (value === undefined) return null;
		const trimmed = value.trim();
		if (trimmed) return { text: trimmed, source: prefill.source };
		current = value;
		currentTitle = requiredTitle;
	}
}

interface DescriptionPrefill {
	text: string;
	source: DescriptionPromptResult["source"];
}

// null = cancelled entirely; empty text = write fresh; non-empty text = selected text to prefill.
async function choosePrefill(ctx: ExtensionCommandContext): Promise<DescriptionPrefill | null> {
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
