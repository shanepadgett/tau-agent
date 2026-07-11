import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type Focusable, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { editorTheme } from "@shanepadgett/tau-tui";
import { bindingHint, bindingsHint, rawHint, type ToolKeyHint } from "@shanepadgett/tau-tui";
import { renderQuestionPrompt } from "./body-render.ts";
import { pushSavedNote, renderInlineEditor, renderNoteEditor, wrapWithPrefix } from "./inline-editor-row.ts";
import { renderRecommendation } from "./input-question-body.ts";
import {
	getAnswer,
	hasCustom,
	moveOption,
	type NormalizedQuestion,
	optionCount,
	type QnaState,
	saveCustomAnswer,
	saveOptionNote,
	toggleOrSelectOption,
} from "./model.ts";

type Mode = "navigate" | "custom" | "note";

export class ChoiceQuestionBody implements Focusable {
	private readonly theme: Theme;
	private readonly getState: () => QnaState;
	private readonly setState: (state: QnaState) => void;
	private readonly advance: () => void;
	private readonly noteEditor: Editor;
	private readonly customEditor: Editor;
	private mode: Mode = "navigate";
	private noteTarget?: { questionId: string; value: string };
	private customQuestionId?: string;
	private activeQuestionId: string | undefined;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		getState: () => QnaState,
		setState: (state: QnaState) => void,
		advance: () => void,
	) {
		this.theme = theme;
		this.getState = getState;
		this.setState = setState;
		this.advance = advance;
		this.noteEditor = new Editor(tui, editorTheme(theme));
		this.customEditor = new Editor(tui, editorTheme(theme));
		this.noteEditor.onSubmit = (value) => this.saveNote(value);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.noteEditor.focused = value && this.mode === "note";
		this.customEditor.focused = value && this.mode === "custom";
	}

	forQuestion(question: NormalizedQuestion): this {
		this.activeQuestionId = question.id;
		this.focused = this._focused;
		return this;
	}

	isEditing(): boolean {
		return this.mode !== "navigate";
	}

	keyHints(): readonly ToolKeyHint[] {
		if (this.mode === "custom") {
			return [bindingHint("tui.input.submit", "save"), bindingHint("tui.select.cancel", "cancel edit")];
		}
		if (this.mode === "note") {
			return [bindingHint("tui.input.submit", "save"), bindingHint("tui.select.cancel", "cancel note")];
		}
		const question = this.currentQuestion();
		return question?.kind === "multi"
			? [
					bindingsHint(["tui.select.up", "tui.select.down"], "move"),
					rawHint("Space", "toggle"),
					bindingHint("tui.select.confirm", "next"),
					rawHint("n", "note"),
				]
			: [
					bindingsHint(["tui.select.up", "tui.select.down"], "move"),
					bindingHint("tui.select.confirm", "choose"),
					rawHint("n", "note"),
				];
	}

	handleInput(data: string): void {
		const question = this.currentQuestion();
		if (!question) return;
		this.activeQuestionId = question.id;
		if (this.mode === "note") {
			this.handleNoteInput(data);
			return;
		}
		if (this.mode === "custom") {
			this.handleCustomInput(data);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.setState(moveOption(this.getState(), -1));
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.setState(moveOption(this.getState(), 1));
			return;
		}
		if (this.isCustomActive(question) && isPrintable(data)) {
			this.openCustom(question, "");
			this.customEditor.handleInput(data);
			return;
		}
		if (data === "n") {
			this.openNote(question);
			return;
		}
		if (matchesKey(data, Key.enter) && question.kind === "multi") {
			this.advance();
			return;
		}
		if (data === " " || matchesKey(data, Key.enter)) this.chooseActive(question);
	}

	render(question: NormalizedQuestion, width: number): string[] {
		this.activeQuestionId = question.id;
		this.focused = this._focused;
		const lines = renderQuestionPrompt(question, width);
		for (let index = 0; index < optionCount(question); index++) {
			if (question.kind === "multi") lines.push(...this.renderMultiOption(question, index, width));
			else lines.push(...this.renderSingleOption(question, index, width));
		}
		lines.push("");
		lines.push(...renderRecommendation(question, width, this.theme));
		return lines;
	}

	closeInactiveEditors(): void {
		if (this.mode === "navigate") return;
		if (this.activeQuestionId === this.getState().questions[this.getState().activeTab]?.id) return;
		this.closeNote();
		this.closeCustom();
	}

	private renderSingleOption(question: NormalizedQuestion, index: number, width: number): string[] {
		if (this.isCustomIndex(question, index)) return this.renderCustomOption(question, false, width);
		const ctx = this.optionContext(question, index);
		if (!ctx) return [];
		const { option, active, selected } = ctx;
		const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
		const label = `${this.theme.fg(active ? "accent" : "text", option.label)}${
			selected ? this.theme.fg("success", " ✓") : ""
		}`;
		const lines = wrapWithPrefix(prefix, label, width);
		this.renderOptionNote(lines, question, option.value, width, "  ");
		return lines;
	}

	private renderMultiOption(question: NormalizedQuestion, index: number, width: number): string[] {
		if (this.isCustomIndex(question, index)) return this.renderCustomOption(question, true, width);
		const ctx = this.optionContext(question, index);
		if (!ctx) return [];
		const { option, active, selected } = ctx;
		const pointer = active ? this.theme.fg("accent", "→ ") : "  ";
		const box = selected ? "[x]" : this.theme.fg("dim", "[ ]");
		const label = this.theme.fg(active ? "accent" : "text", option.label);
		const lines = wrapWithPrefix(`${pointer}${box} `, label, width);
		this.renderOptionNote(lines, question, option.value, width, "      ");
		return lines;
	}

	private renderCustomOption(question: NormalizedQuestion, multi: boolean, width: number): string[] {
		const answer = getAnswer(this.getState(), question.id);
		const active = this.isCustomActive(question);
		const editing = active && this.mode === "custom" && this.customQuestionId === question.id;
		const draftSelected = editing ? Boolean(clean(this.customEditor.getText())) : false;
		const selected = Boolean(answer.custom) || draftSelected;
		const pointer = active ? this.theme.fg("accent", "→ ") : "  ";
		const box = multi ? `${selected ? "[x]" : this.theme.fg("dim", "[ ]")} ` : "";
		const prefix = `${pointer}${box}`;
		if (editing) return renderInlineEditor(prefix, this.customEditor, width);
		const label = answer.custom || "Type your own answer...";
		return wrapWithPrefix(
			prefix,
			`${this.theme.fg(active ? "accent" : "text", label)}${
				!multi && selected ? this.theme.fg("success", " ✓") : ""
			}`,
			width,
		);
	}

	private optionContext(question: NormalizedQuestion, index: number) {
		const option = question.options[index];
		if (!option) return null;
		const answer = getAnswer(this.getState(), question.id);
		const active = index === this.getState().activeOption;
		const selected = answer.selected.includes(option.value);
		return { option, active, selected };
	}

	private renderOptionNote(
		lines: string[],
		question: NormalizedQuestion,
		value: string,
		width: number,
		indent: string,
	): void {
		if (this.mode === "note" && this.noteTarget?.questionId === question.id && this.noteTarget.value === value) {
			renderNoteEditor(lines, this.noteEditor, width, this.theme, indent);
			return;
		}
		const note = getAnswer(this.getState(), question.id).notes[value];
		if (note) pushSavedNote(lines, note, width, this.theme, indent);
	}

	private chooseActive(question: NormalizedQuestion): void {
		if (this.isCustomActive(question)) {
			this.openCustom(question, getAnswer(this.getState(), question.id).custom || "");
			return;
		}
		const option = question.options[this.getState().activeOption];
		if (!option) return;
		this.setState(toggleOrSelectOption(this.getState(), question, option.value));
		if (question.kind !== "multi") this.advance();
	}

	private openNote(question: NormalizedQuestion): void {
		const option = question.options[this.getState().activeOption];
		if (!option) return;
		this.noteTarget = { questionId: question.id, value: option.value };
		this.mode = "note";
		this.noteEditor.setText(getAnswer(this.getState(), question.id).notes[option.value] || "");
		this.focused = this._focused;
	}

	private openCustom(question: NormalizedQuestion, value: string): void {
		this.mode = "custom";
		this.customQuestionId = question.id;
		this.customEditor.setText(value);
		this.focused = this._focused;
	}

	private handleNoteInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.closeNote();
			return;
		}
		this.noteEditor.handleInput(data);
	}

	private handleCustomInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.closeCustom();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.saveCustom();
			return;
		}
		this.customEditor.handleInput(data);
	}

	private saveNote(value: string): void {
		const question = this.currentQuestion();
		if (question && this.noteTarget) {
			this.setState(saveOptionNote(this.getState(), question, this.noteTarget.value, value));
		}
		this.closeNote();
	}

	private saveCustom(): void {
		const question = this.currentQuestion();
		if (!question) return;
		this.setState(saveCustomAnswer(this.getState(), question, this.customEditor.getText()));
		this.closeCustom();
		this.advance();
	}

	private closeNote(): void {
		this.mode = "navigate";
		this.noteTarget = undefined;
		this.noteEditor.setText("");
		this.focused = this._focused;
	}

	private closeCustom(): void {
		this.mode = "navigate";
		this.customQuestionId = undefined;
		this.customEditor.setText("");
		this.focused = this._focused;
	}

	private currentQuestion(): NormalizedQuestion | undefined {
		return this.getState().questions.find((question) => question.id === this.activeQuestionId);
	}

	private isCustomActive(question: NormalizedQuestion): boolean {
		return this.isCustomIndex(question, this.getState().activeOption);
	}

	private isCustomIndex(question: NormalizedQuestion, index: number): boolean {
		return hasCustom(question) && index === question.options.length;
	}
}

function isPrintable(data: string): boolean {
	return (
		data.length > 0 &&
		![...data].some((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		})
	);
}

function clean(value: string): string {
	return value.trim();
}
