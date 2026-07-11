import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { createState, type NormalizedQuestion, type QnaResult } from "./model.ts";
import { QnaPanel } from "./panel.ts";

type QnaUiResult = QnaResult | undefined;

export function runQnaUi(
	tui: TUI,
	theme: Theme,
	title: string | undefined,
	questions: NormalizedQuestion[],
	done: (result: QnaUiResult) => void,
): Component {
	return new QnaPanel(tui, theme, createState(title, questions), done);
}
