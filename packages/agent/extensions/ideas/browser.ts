import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { rawHint } from "@shanepadgett/tau-tui";
import {
	createTextRecordSelectPanel,
	type TextRecordSelectPanelConfig,
	type TextRecordSelectResult,
} from "@shanepadgett/tau-tui";
import { errorText } from "../../shared/text.ts";
import { deleteIdea, type Idea, ideasFilePath, loadIdeas, updateIdea } from "./store.ts";

const CONFIG: Omit<TextRecordSelectPanelConfig<Idea>, "path" | "destructiveAction"> = {
	title: "Ideas",
	emptyMessage: "No ideas yet. Use /ideas <text> to log one.",
	primaryLabel: "insert",
	expandActiveItem: true,
	actions: [{ id: "edit", key: Key.ctrl("e"), hint: rawHint("ctrl+e", "edit") }],
};

export async function browseIdeas(ctx: ExtensionCommandContext): Promise<Idea | undefined> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Ideas browser requires TUI mode.", "error");
		return undefined;
	}

	const path = await ideasFilePath(ctx.cwd);

	while (true) {
		const ideas = await loadIdeas(ctx.cwd);
		const result = await show(ctx, ideas, path);

		if (result.kind === "cancel") return undefined;
		if (result.kind === "primary") return result.item;

		// edit: native multiline editor, prefilled with the current text.
		const edited = await ctx.ui.editor("Edit idea", result.item.text);
		if (edited == null) continue;
		if (!edited.trim()) {
			ctx.ui.notify("Edit cancelled (empty).", "info");
			continue;
		}
		await updateIdea(ctx.cwd, result.item.id, edited);
		ctx.ui.notify("Idea updated.", "info");
	}
}

async function show(
	ctx: ExtensionCommandContext,
	ideas: readonly Idea[],
	path: string,
): Promise<TextRecordSelectResult<Idea>> {
	return ctx.ui.custom<TextRecordSelectResult<Idea>>((tui, theme, _keybindings, done) =>
		createTextRecordSelectPanel(
			tui,
			theme,
			ideas,
			{
				...CONFIG,
				path,
				destructiveAction: {
					id: "delete",
					key: Key.ctrl("d"),
					hint: rawHint("ctrl+d", "delete"),
					confirmLabel: () => "Delete idea?",
					runningLabel: "Deleting idea…",
					onConfirm: async (item) => {
						const next = await deleteIdea(ctx.cwd, item.id);
						ctx.ui.notify("Idea deleted.", "info");
						return next;
					},
					onError: (error) => ctx.ui.notify(`Idea delete failed: ${errorText(error)}`, "error"),
				},
			},
			done,
		),
	);
}
