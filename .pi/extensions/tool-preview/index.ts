import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, TUI } from "@earendil-works/pi-tui";
import { createFindPreviewWidget } from "./widgets/find.ts";
import { createGrepPreviewWidget } from "./widgets/grep.ts";
import { createLsPreviewWidget } from "./widgets/ls.ts";
import { createPatchPreviewWidget } from "./widgets/patch.ts";
import { createReadPreviewWidget } from "./widgets/read.ts";

const COMMAND = "tool-preview";
const WIDGETS: Record<string, (tui: TUI, cwd: string, theme: Theme) => Component> = {
	find: createFindPreviewWidget,
	grep: createGrepPreviewWidget,
	ls: createLsPreviewWidget,
	patch: createPatchPreviewWidget,
	read: createReadPreviewWidget,
};
const ARGUMENTS = [
	{ value: "grep", label: "grep", description: "Show grep row states" },
	{ value: "find", label: "find", description: "Show find row states" },
	{ value: "ls", label: "ls", description: "Show ls row states" },
	{ value: "patch", label: "patch", description: "Show patch row states" },
	{ value: "read", label: "read", description: "Show read row states" },
	{ value: "clear", label: "clear", description: "Hide the preview widget" },
] satisfies AutocompleteItem[];

export default function toolPreview(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND, {
		description: "Preview custom tool UI widgets",
		getArgumentCompletions(prefix) {
			const query = prefix.trim();
			const items = ARGUMENTS.filter((item) => item.value.startsWith(query));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Tool preview requires TUI mode", "error");
				return;
			}

			const command = args.trim();
			if (command === "" || command === "clear") {
				ctx.ui.setWidget(COMMAND, undefined);
				return;
			}

			const createWidget = WIDGETS[command];
			if (!createWidget) {
				ctx.ui.notify(`Unknown tool preview: ${command}`, "error");
				return;
			}

			ctx.ui.setWidget(COMMAND, (tui, theme) => createWidget(tui, ctx.cwd, theme), {
				placement: "aboveEditor",
			});
		},
	});
}
