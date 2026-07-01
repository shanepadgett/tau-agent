import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { createAutoreadPreviewWidget } from "./widgets/autoread.ts";
import { createFindPreviewWidget } from "./widgets/find.ts";
import { createGrepPreviewWidget } from "./widgets/grep.ts";
import { framePreviewWidget } from "./widgets/layout.ts";
import { createLsPreviewWidget } from "./widgets/ls.ts";
import { createPatchPreviewWidget } from "./widgets/patch.ts";
import { createReadPreviewWidget } from "./widgets/read.ts";
import { createTabsListPreviewWidget } from "./widgets/tabs-list.ts";
import { createToolPanelPreviewWidget } from "./widgets/tool-panel.ts";
import { createTurnBudgetPreviewWidget } from "./widgets/turn-budget.ts";

const COMMAND = "tool-preview";
const WIDGETS: Record<string, (tui: TUI, cwd: string, theme: Theme) => Component> = {
	autoread: createAutoreadPreviewWidget,
	find: createFindPreviewWidget,
	grep: createGrepPreviewWidget,
	ls: createLsPreviewWidget,
	patch: createPatchPreviewWidget,
	read: createReadPreviewWidget,
	"tabs-list": createTabsListPreviewWidget,
	"tool-panel": createToolPanelPreviewWidget,
	"turn-budget": createTurnBudgetPreviewWidget,
};
const ARGUMENTS = [
	{ value: "autoread", label: "autoread", description: "Show autoread line states" },
	{ value: "grep", label: "grep", description: "Show grep row states" },
	{ value: "find", label: "find", description: "Show find row states" },
	{ value: "ls", label: "ls", description: "Show ls row states" },
	{ value: "patch", label: "patch", description: "Show patch row states" },
	{ value: "read", label: "read", description: "Show read row states" },
	{ value: "tabs-list", label: "tabs-list", description: "Show shared Tabs and MultiSelectList states" },
	{ value: "tool-panel", label: "tool-panel", description: "Show shared ToolPanel states" },
	{ value: "turn-budget", label: "turn-budget", description: "Show turn-budget hint states" },
	{ value: "clear", label: "clear", description: "Hide the preview widget" },
] satisfies AutocompleteItem[];

export default function toolPreview(pi: ExtensionAPI): void {
	let clearOnEscape: (() => void) | undefined;
	pi.on("session_shutdown", () => {
		clearOnEscape?.();
		clearOnEscape = undefined;
	});

	pi.registerCommand(COMMAND, {
		description: "Preview custom tool UI widgets",
		getArgumentCompletions(prefix) {
			const query = prefix.trim();
			const items = ARGUMENTS.filter((item) => item.value.startsWith(query));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const clearPreview = () => {
				ctx.ui.setWidget(COMMAND, undefined);
				clearOnEscape?.();
				clearOnEscape = undefined;
			};

			if (ctx.mode !== "tui") {
				ctx.ui.notify("Tool preview requires TUI mode", "error");
				return;
			}

			const command = args.trim();
			if (command === "" || command === "clear") {
				clearPreview();
				return;
			}

			const createWidget = WIDGETS[command];
			if (!createWidget) {
				ctx.ui.notify(`Unknown tool preview: ${command}`, "error");
				return;
			}

			ctx.ui.setWidget(COMMAND, (tui, theme) => framePreviewWidget(theme, createWidget(tui, ctx.cwd, theme)), {
				placement: "aboveEditor",
			});
			clearOnEscape?.();
			clearOnEscape = ctx.ui.onTerminalInput((data) => {
				if (!matchesKey(data, "escape")) return undefined;
				clearPreview();
				return { consume: true };
			});
		},
	});
}
