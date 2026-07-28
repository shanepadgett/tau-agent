import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { rawHint } from "@shanepadgett/tau-tui";
import {
	createTextRecordSelectPanel,
	type TextRecordSelectPanelConfig,
	type TextRecordSelectResult,
} from "@shanepadgett/tau-tui";
import { errorText } from "../../shared/text.ts";
import { loadStashes, removeStash, type Stash, stashFilePath } from "./store.ts";

const CONFIG: Omit<TextRecordSelectPanelConfig<Stash>, "path" | "destructiveAction"> = {
	title: "Stash",
	emptyMessage: "No stashed prompts. Use the stash shortcut while typing to stash.",
	primaryLabel: "pop",
	actions: [],
	expandActiveItem: false,
};

export async function browseStash(ctx: ExtensionCommandContext): Promise<Stash | undefined> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Stash browser requires TUI mode.", "error");
		return undefined;
	}

	const path = await stashFilePath(ctx.cwd);

	const stashes = await loadStashes(ctx.cwd);
	const result = await show(ctx, stashes, path);
	return result.kind === "primary" ? result.item : undefined;
}

async function show(
	ctx: ExtensionCommandContext,
	stashes: readonly Stash[],
	path: string,
): Promise<TextRecordSelectResult<Stash>> {
	return ctx.ui.custom<TextRecordSelectResult<Stash>>((tui, theme, _keybindings, done) =>
		createTextRecordSelectPanel(
			tui,
			theme,
			stashes,
			{
				...CONFIG,
				path,
				destructiveAction: {
					id: "discard",
					key: Key.ctrl("d"),
					hint: rawHint("ctrl+d", "discard"),
					confirmLabel: () => "Discard stashed prompt?",
					runningLabel: "Discarding stashed prompt…",
					onConfirm: async (item) => {
						const next = await removeStash(ctx.cwd, item.id);
						ctx.ui.notify("Stash discarded.", "info");
						return next;
					},
					onError: (error) => ctx.ui.notify(`Stash discard failed: ${errorText(error)}`, "error"),
				},
			},
			done,
		),
	);
}
