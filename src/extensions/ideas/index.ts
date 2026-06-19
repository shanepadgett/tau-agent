import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { browseIdeas } from "./browser.ts";
import { addIdea } from "./store.ts";

export default function ideasExtension(pi: ExtensionAPI): void {
	pi.registerCommand("ideas", {
		description: "Log a rough idea for this repo, or browse ideas with no args",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const text = args.trim();
			if (text) {
				const idea = await addIdea(ctx.cwd, text);
				ctx.ui.notify(`Logged idea: ${preview(idea.text)}`, "info");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("Use /ideas <text> to log, or run in TUI to browse.", "info");
				return;
			}

			const idea = await browseIdeas(ctx);
			if (idea) {
				ctx.ui.setEditorText(idea.text);
				ctx.ui.notify("Idea loaded into the editor — edit and submit.", "info");
			}
		},
	});
}

function preview(text: string, max = 60): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
