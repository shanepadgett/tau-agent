import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import {
	createReadStatsPanel,
	type ReadSavingsSnapshot,
} from "../../../../packages/agent/extensions/explore/read-stats-panel.ts";

const ACTIVE_BRANCH: ReadSavingsSnapshot = {
	label: "Current chat",
	secondary: "47 reads in this chat",
	baselineTokens: 1_440_000,
	returnedTokens: 158_000,
	costSaved: 3.84,
	unchangedCost: 2.71,
	diffCost: 1.13,
	counts: { baseline: 12, recovery: 1, unchanged: 24, diff: 10 },
};

const ENTIRE_SESSION: ReadSavingsSnapshot = {
	label: "Whole session",
	secondary: "58 reads across everything done in this session",
	baselineTokens: 1_820_000,
	returnedTokens: 209_000,
	costSaved: 4.76,
	unchangedCost: 3.34,
	diffCost: 1.42,
	counts: { baseline: 15, recovery: 1, unchanged: 30, diff: 12 },
};

export function createReadStatsPreviewOverlay(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: unknown) => void,
): Component {
	return createReadStatsPanel(tui, theme, keybindings, done, ACTIVE_BRANCH, ENTIRE_SESSION);
}
