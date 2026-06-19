import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { preview } from "../../shared/text.ts";
import { browseStash } from "./browser.ts";
import { addStash, removeStash } from "./store.ts";

export default function stashExtension(pi: ExtensionAPI): void {
	// Stash = keybinding only. You hit it mid-type to park whatever's in the
	// editor without leaving the keyboard to run a slash command.
	pi.registerShortcut(Key.ctrlShift("s"), {
		description: "Stash the current prompt draft",
		handler: async (_ctx) => {
			if (_ctx.mode !== "tui" || !_ctx.hasUI) {
				_ctx.ui.notify("Stash keybinding works only in TUI mode.", "error");
				return;
			}

			const text = _ctx.ui.getEditorText().trim();
			if (!text) {
				_ctx.ui.notify("Nothing to stash.", "info");
				return;
			}

			const stash = await addStash(_ctx.cwd, text);
			if (!stash) {
				_ctx.ui.notify("Already stashed.", "info");
				return;
			}

			_ctx.ui.setEditorText("");
			_ctx.ui.notify(`Stashed: ${preview(stash.text, 60)}`, "info");
		},
	});

	// Pop = command, opens the browser. Restoring a stash removes it from the
	// store so the list doesn't linger; re-stash to put it back.
	pi.registerCommand("pop", {
		description: "Browse stashed prompts and pop one into the editor (TUI)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			if (ctx.mode !== "tui") {
				ctx.ui.notify("Run /pop in TUI to browse stashed prompts.", "info");
				return;
			}

			const stash = await browseStash(ctx);
			if (!stash) return;

			ctx.ui.setEditorText(stash.text);
			await removeStash(ctx.cwd, stash.id);
			ctx.ui.notify("Popped into the editor — edit and submit.", "info");
		},
	});
}
