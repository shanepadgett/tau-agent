import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createGitRunner } from "../../shared/git.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { cloneFromCommand, type ReferenceItem, showReferencePanel } from "./panel.ts";
import referenceSettings from "./settings.ts";

export default function referenceExtension(pi: ExtensionAPI): void {
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
				const url = rest.join(" ").trim();
				if (!url) {
					ctx.ui.notify("Git URL is required.", "error");
					return;
				}

				await cloneFromCommand(ctx, url);
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

			const settings = await loadTauExtensionSettings(ctx, referenceSettings);
			const references = await showReferencePanel(
				createGitRunner(pi, ctx),
				ctx,
				settings.editor,
				settings.branchChoices,
			);
			if (!references) return;

			ctx.ui.setEditorText(buildReferenceDraft(references));
		},
	});
}

function buildReferenceDraft(references: readonly ReferenceItem[]): string {
	return [
		...(references.length === 0
			? []
			: [
					"Reference repositories:",
					...references.map((ref) => `- ${ref.name}: ${ref.path}${ref.dirty ? " (dirty)" : ""}`),
					"",
					"Use references as read-only examples. Search/read only files needed for this request.",
				]),
		"",
		"Request:",
		"",
	].join("\n");
}
