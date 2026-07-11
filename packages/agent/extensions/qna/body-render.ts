import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { NormalizedQuestion } from "./model.ts";

export function renderQuestionPrompt(question: NormalizedQuestion, width: number): string[] {
	return [...wrapTextWithAnsi(question.prompt, width), ""];
}
