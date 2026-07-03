import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderQuestionPrompt } from "./body-render.ts";
import { getAnswer, type NormalizedQuestion, type QnaState, saveInputAnswer } from "./model.ts";

export class InputQuestionBody implements Focusable {
	private readonly theme: Theme;
	private readonly getState: () => QnaState;
	private readonly setState: (state: QnaState) => void;
	private readonly advance: () => void;
	private readonly inputs = new Map<string, Input>();
	private activeQuestionId: string | undefined;
	private _focused = false;

	constructor(theme: Theme, getState: () => QnaState, setState: (state: QnaState) => void, advance: () => void) {
		this.theme = theme;
		this.getState = getState;
		this.setState = setState;
		this.advance = advance;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		for (const [id, input] of this.inputs) input.focused = value && id === this.activeQuestionId;
	}

	forQuestion(question: NormalizedQuestion): this {
		this.activeQuestionId = question.id;
		this.focused = this._focused;
		return this;
	}

	handleInput(data: string): void {
		const question = this.currentQuestion();
		if (!question) return;
		const input = this.getQuestionInput(question);
		if (matchesKey(data, Key.enter)) {
			this.setState(saveInputAnswer(this.getState(), question, input.getValue()));
			this.advance();
			return;
		}
		input.handleInput(data);
		this.setState(saveInputAnswer(this.getState(), question, input.getValue()));
	}

	render(question: NormalizedQuestion, width: number): string[] {
		this.activeQuestionId = question.id;
		this.focused = this._focused;
		const lines = renderQuestionPrompt(question, width);
		lines.push(...renderRecommendation(question, width, this.theme));
		if (question.recommendation) lines.push("");
		lines.push(
			...this.getQuestionInput(question)
				.render(width)
				.map((line) => truncateToWidth(line, width, "")),
		);
		return lines;
	}

	private currentQuestion(): NormalizedQuestion | undefined {
		return this.getState().questions.find((question) => question.id === this.activeQuestionId);
	}

	private getQuestionInput(question: NormalizedQuestion): Input {
		const existing = this.inputs.get(question.id);
		if (existing) return existing;
		const input = new Input();
		const value = getAnswer(this.getState(), question.id).input;
		if (value) input.handleInput(value);
		input.focused = this._focused && this.activeQuestionId === question.id;
		this.inputs.set(question.id, input);
		return input;
	}
}

export function renderRecommendation(question: NormalizedQuestion, width: number, theme: Theme): string[] {
	if (!question.recommendation) return [];
	const labels = question.recommendation.values.map(
		(value) => question.options.find((option) => option.value === value)?.label ?? value,
	);
	return [
		...wrapTextWithAnsi(`${theme.fg("muted", theme.bold("Recommendation: "))}${labels.join(", ")}`, width),
		...wrapTextWithAnsi(theme.fg("muted", `${theme.bold("Reason: ")}${question.recommendation.reason}`), width),
	];
}
