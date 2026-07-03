import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type QnaState, saveAdditionalContext } from "./model.ts";

export class AdditionalContextBody implements Component, Focusable {
	private readonly getState: () => QnaState;
	private readonly setState: (state: QnaState) => void;
	private readonly submit: () => void;
	private readonly input = new Input();

	constructor(getState: () => QnaState, setState: (state: QnaState) => void, submit: () => void) {
		this.getState = getState;
		this.setState = setState;
		this.submit = submit;
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.setState(saveAdditionalContext(this.getState(), this.input.getValue()));
			this.submit();
			return;
		}
		this.input.handleInput(data);
		this.setState(saveAdditionalContext(this.getState(), this.input.getValue()));
	}

	render(width: number): string[] {
		return [
			...wrapTextWithAnsi("Any additional context for the agent? Optional.", width),
			"",
			...this.input.render(width).map((line) => truncateToWidth(line, width, "")),
		];
	}

	invalidate(): void {}
}
