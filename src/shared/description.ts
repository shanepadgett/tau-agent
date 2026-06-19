import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { browseIdeas } from "../extensions/ideas/browser.ts";

/**
 * Prompt for a description in the native editor, with an option to prefill
 * from the ideas store. A chosen idea lands in the editor as editable text
 * before submit, so it can be shaped into the request.
 *
 * The native editor modal exposes no custom-key hook, so source selection
 * (write vs. pull from ideas) happens in a select step before the editor,
 * and the idea text is passed as the editor's prefill.
 *
 * Returns the trimmed description, or null if the user cancelled at any step.
 */
export async function promptForDescription(
	ctx: ExtensionCommandContext,
	title: string,
	requiredTitle: string,
): Promise<string | null> {
	const prefill = await choosePrefill(ctx);
	if (prefill === null) return null;

	let currentTitle = title;
	let current = prefill;
	while (true) {
		const value = await ctx.ui.editor(currentTitle, current);
		if (value === undefined) return null;
		const trimmed = value.trim();
		if (trimmed) return trimmed;
		current = value;
		currentTitle = requiredTitle;
	}
}

// null = cancelled entirely; "" = write fresh; non-empty = idea text to prefill.
async function choosePrefill(ctx: ExtensionCommandContext): Promise<string | null> {
	while (true) {
		const choice = await ctx.ui.select("Description source", ["Write description", "Pull from ideas"]);
		if (choice === undefined) return null;
		if (choice === "Write description") return "";
		const idea = await browseIdeas(ctx);
		if (idea) return idea.text;
		// Browser cancelled without a pick; loop back to source select.
	}
}
