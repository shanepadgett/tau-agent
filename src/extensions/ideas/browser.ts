import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { rawHint } from "../../shared/tui/key-hints.ts";
import {
	createTextRecordSelectPanel,
	type TextRecordSelectPanelConfig,
	type TextRecordSelectResult,
} from "../../shared/tui/text-record-select-panel.ts";
import { deleteIdea, type Idea, ideasFilePath, loadIdeas, updateIdea } from "./store.ts";

const CONFIG: Omit<TextRecordSelectPanelConfig, "path"> = {
	title: "Ideas",
	emptyMessage: "No ideas yet. Use /ideas <text> to log one.",
	primaryLabel: "insert",
	expandActiveItem: true,
	actions: [
		{ id: "edit", key: Key.ctrl("e"), hint: rawHint("ctrl+e", "edit") },
		{ id: "delete", key: Key.ctrl("d"), hint: rawHint("ctrl+d", "delete") },
	],
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

		if (result.actionId === "delete") {
			const ok = await ctx.ui.confirm("Delete idea?", result.item.text);
			if (ok) {
				await deleteIdea(ctx.cwd, result.item.id);
				ctx.ui.notify("Idea deleted.", "info");
			}
			continue;
		}

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
	return ctx.ui.custom<TextRecordSelectResult<Idea>>((_tui, theme, _keybindings, done) =>
		createTextRecordSelectPanel(theme, ideas, { ...CONFIG, path }, done),
	);
}
