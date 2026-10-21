import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createGitRunner } from "../../shared/git.ts";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { ATTACHMENTS_TYPE, readReferenceAttachments, type ReferenceAttachmentState } from "./attachments.ts";
import { cloneFromCommand, showReferencePanel } from "./panel.ts";
import referenceSettings from "./settings.ts";

export default function referenceExtension(pi: ExtensionAPI): void {
	registerPromptSource(pi, {
		key: "reference/attachments",
		section: "references",
		refresh: "append",
		async read(ctx) {
			const references = readReferenceAttachments(ctx.sessionManager.getBranch());
			if (references.length === 0) return "";
			return [
				"Reference repositories attached to this conversation:",
				...references.map((ref) => `- ${ref.name}: ${ref.path}`),
				"",
				"Use references as read-only examples. Search/read only files needed for the current task.",
			].join("\n");
		},
	});

	pi.registerCommand("reference", {
		description: "Manage references attached to this conversation or add a reference repo",
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
				readReferenceAttachments(ctx.sessionManager.getBranch()),
			);
			if (!references) return;

			pi.appendEntry<ReferenceAttachmentState>(ATTACHMENTS_TYPE, {
				references: references
					.map(({ name, path }) => ({ name, path }))
					.sort((left, right) => left.path.localeCompare(right.path, "en")),
			});
			ctx.ui.notify(
				references.length === 0
					? "All references detached."
					: `Saved ${references.length} reference attachment${references.length === 1 ? "" : "s"}.`,
				"info",
			);
		},
	});
}
