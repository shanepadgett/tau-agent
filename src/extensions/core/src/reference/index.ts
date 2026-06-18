import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	addReference,
	pickReferences,
	type ReferenceItem,
	referenceLines,
} from "../../../../shared/reference-picker.ts";

export function registerReference(pi: ExtensionAPI): void {
	pi.registerCommand("reference", {
		description: "Select local code references or add a new reference repo",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const value = prefix.trimStart();
			if (/\s/.test(value)) return null;

			const item = {
				value: "new",
				label: "new",
				description: "Add a new reference repo",
			};
			return item.value.startsWith(value) ? [item] : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const trimmed = args.trim();
			const [head = "", ...rest] = trimmed.split(/\s+/);
			if (head === "new") {
				await addReference(pi, ctx, rest.join(" ").trim());
				return;
			}

			if (trimmed) {
				ctx.ui.notify("Usage: /reference or /reference new <git-url>", "warning");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("/reference requires TUI mode. Use /reference new <git-url> to add only.", "error");
				return;
			}

			const references = await pickReferences(pi, ctx);
			if (references) await sendReferencePrompt(pi, ctx, references);
		},
	});
}

async function sendReferencePrompt(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	references: readonly ReferenceItem[],
): Promise<void> {
	const prompt = await ctx.ui.editor("Reference prompt", "");
	if (!prompt?.trim()) {
		ctx.ui.notify("Reference prompt cancelled.", "info");
		return;
	}

	const message = buildReferencePrompt(references, prompt);
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
	} else {
		pi.sendUserMessage(message, { deliverAs: "followUp" });
	}
}

function buildReferencePrompt(references: readonly ReferenceItem[], prompt: string): string {
	return [...referenceLines(references), "", "<request>", prompt.trim(), "</request>"].join("\n");
}
