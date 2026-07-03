import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
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

interface PreviewStory {
	label: string;
	createWidget(tui: TUI, cwd: string, theme: Theme): Component;
}

const STORIES: readonly PreviewStory[] = [
	{ label: "autoread — line states", createWidget: createAutoreadPreviewWidget },
	{ label: "grep — row states", createWidget: createGrepPreviewWidget },
	{ label: "find — row states", createWidget: createFindPreviewWidget },
	{ label: "ls — row states", createWidget: createLsPreviewWidget },
	{ label: "patch — row states", createWidget: createPatchPreviewWidget },
	{ label: "read — row states", createWidget: createReadPreviewWidget },
	{ label: "tabs-list — Tabs and MultiSelectList", createWidget: createTabsListPreviewWidget },
	{ label: "tool-panel — shell states", createWidget: createToolPanelPreviewWidget },
	{ label: "turn-budget — marker states", createWidget: createTurnBudgetPreviewWidget },
];

export default function toolPreview(pi: ExtensionAPI): void {
	let clearOnEscape: (() => void) | undefined;
	pi.on("session_shutdown", () => {
		clearOnEscape?.();
		clearOnEscape = undefined;
	});

	pi.registerCommand(COMMAND, {
		description: "Preview custom tool UI widgets",
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

			clearPreview();

			if (args.trim()) {
				ctx.ui.notify("Use /tool-preview with no arguments and pick a story.", "info");
				return;
			}

			const label = await ctx.ui.select(
				"Tool preview",
				STORIES.map((story) => story.label),
			);
			const story = STORIES.find((item) => item.label === label);
			if (!story) return;

			ctx.ui.setWidget(COMMAND, (tui, theme) => framePreviewWidget(theme, story.createWidget(tui, ctx.cwd, theme)), {
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
