import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { rawHint } from "@shanepadgett/tau-tui";
import {
	createTextRecordSelectPanel,
	type TextRecordSelectPanelConfig,
	type TextRecordSelectResult,
} from "@shanepadgett/tau-tui";
import { loadStashes, removeStash, type Stash, stashFilePath } from "./store.ts";

const CONFIG: Omit<TextRecordSelectPanelConfig, "path"> = {
	title: "Stash",
	emptyMessage: "No stashed prompts. Use the stash shortcut while typing to stash.",
	primaryLabel: "pop",
	actions: [{ id: "discard", key: Key.ctrl("d"), hint: rawHint("ctrl+d", "discard") }],
	expandActiveItem: false,
};

export async function browseStash(ctx: ExtensionCommandContext): Promise<Stash | undefined> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Stash browser requires TUI mode.", "error");
		return undefined;
	}

	const path = await stashFilePath(ctx.cwd);

	while (true) {
		const stashes = await loadStashes(ctx.cwd);
		const result = await show(ctx, stashes, path);

		if (result.kind === "cancel") return undefined;
		if (result.kind === "primary") return result.item;

		// discard: drop the stashed prompt without restoring it.
		const ok = await ctx.ui.confirm("Discard stashed prompt?", result.item.text);
		if (ok) {
			await removeStash(ctx.cwd, result.item.id);
			ctx.ui.notify("Stash discarded.", "info");
		}
	}
}

async function show(
	ctx: ExtensionCommandContext,
	stashes: readonly Stash[],
	path: string,
): Promise<TextRecordSelectResult<Stash>> {
	return ctx.ui.custom<TextRecordSelectResult<Stash>>((_tui, theme, _keybindings, done) =>
		createTextRecordSelectPanel(theme, stashes, { ...CONFIG, path }, done),
	);
}
