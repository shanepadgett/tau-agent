import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	activeQuestion,
	buildResult,
	createState,
	getAnswer,
	hasCustom,
	isAnswered,
	moveOption,
	moveTab,
	type NormalizedQuestion,
	optionCount,
	type QnaResult,
	type QnaState,
	saveCustomAnswer,
	saveInputAnswer,
	saveOptionNote,
	toggleOrSelectOption,
} from "./model.ts";

type QnaUiResult = QnaResult | undefined;
type ViewMode = "navigate" | "custom" | "note";

export function runQnaUi(
	tui: TUI,
	theme: Theme,
	title: string | undefined,
	questions: NormalizedQuestion[],
	done: (result: QnaUiResult) => void,
): Component {
	return new QnaComponent(tui, theme, createState(title, questions), done);
}

class QnaComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (result: QnaUiResult) => void;
	private readonly editor: Editor;
	private readonly customEditor: Editor;
	private readonly inputs = new Map<string, Input>();
	private state: QnaState;
	private mode: ViewMode = "navigate";
	private noteTarget?: { questionId: string; value: string };
	private customQuestionId?: string;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, state: QnaState, done: (result: QnaUiResult) => void) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
		this.done = done;
		this.editor = new Editor(tui, editorTheme(theme));
		this.customEditor = new Editor(tui, editorTheme(theme));
		this.editor.onSubmit = (value) => this.saveNote(value);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
		this.customEditor.focused = value;
		for (const input of this.inputs.values()) input.focused = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}

		if (this.mode === "note") {
			this.handleNoteInput(data);
			return;
		}

		if (this.mode === "custom") {
			this.handleCustomInput(data);
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}

		if (matchesKey(data, Key.ctrl("s"))) {
			this.done(buildResult(this.state));
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.state = moveTab(this.state, 1);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.state = moveTab(this.state, -1);
			this.refresh();
			return;
		}

		const question = activeQuestion(this.state);
		if (!question) return;

		if (question.kind === "input") {
			this.handleQuestionInput(data, question);
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.state = moveOption(this.state, -1);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.state = moveOption(this.state, 1);
			this.refresh();
			return;
		}

		if (this.isCustomActive(question) && isPrintable(data)) {
			this.openCustom(question, "");
			this.customEditor.handleInput(data);
			this.refresh();
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

		if (data === " " || matchesKey(data, Key.enter)) {
			this.chooseActive(question);
		}
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		lines.push(truncateToWidth(this.theme.bold(`qna: ${this.state.title || "Question"}`), renderWidth, ""));
		lines.push("");
		if (this.state.questions.length > 1) {
			lines.push(this.renderTabs(renderWidth));
			lines.push("");
		}
		lines.push(...this.renderQuestion(renderWidth));
		lines.push("");
		lines.push(...this.footer(renderWidth));
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		return lines;
	}

	invalidate(): void {}

	private renderTabs(width: number): string {
		const tabs = this.state.questions.map((question, index) => {
			const label = `${question.label}${isAnswered(this.state, question) ? "•" : ""}`;
			const text = `[${label}]`;
			return {
				width: visibleWidth(text),
				render:
					index === this.state.activeTab
						? this.theme.fg("accent", this.theme.bold(text))
						: this.theme.fg("muted", text),
			};
		});

		const totalWidth = tabs.reduce((sum, tab) => sum + tab.width, 0) + Math.max(0, tabs.length - 1);
		if (totalWidth <= width) return truncateToWidth(tabs.map((tab) => tab.render).join(" "), width, "");

		const available = Math.max(1, width - visibleWidth("← ") - visibleWidth(" →"));
		const { start, end } = visibleTabRange(
			tabs.map((tab) => tab.width),
			this.state.activeTab,
			available,
		);
		return truncateToWidth(
			`${this.theme.fg("dim", "← ")}${tabs
				.slice(start, end + 1)
				.map((tab) => tab.render)
				.join(" ")}${this.theme.fg("dim", " →")}`,
			width,
			"",
		);
	}

	private renderQuestion(width: number): string[] {
		const question = activeQuestion(this.state);
		if (!question) return [];
		const lines: string[] = [];
		lines.push(...wrapTextWithAnsi(question.prompt, width));
		lines.push("");
		if (question.kind === "input") {
			lines.push(...this.renderRecommendation(question, width));
			if (question.recommendation) lines.push("");
			lines.push(...this.renderInputQuestion(question, width));
			return lines;
		}
		lines.push(...this.renderOptions(question, width));
		lines.push("");
		lines.push(...this.renderRecommendation(question, width));
		return lines;
	}

	private renderInputQuestion(question: NormalizedQuestion, width: number): string[] {
		return this.getQuestionInput(question)
			.render(width)
			.map((line) => truncateToWidth(line, width, ""));
	}

	private renderOptions(question: NormalizedQuestion, width: number): string[] {
		const lines: string[] = [];
		for (let index = 0; index < optionCount(question); index++) {
			if (question.kind === "multi") lines.push(...this.renderMultiOption(question, index, width));
			else lines.push(...this.renderSingleOption(question, index, width));
		}
		return lines;
	}

	private renderSingleOption(question: NormalizedQuestion, index: number, width: number): string[] {
		if (this.isCustomIndex(question, index)) return this.renderCustomOption(question, false, width);

		const option = question.options[index];
		if (!option) return [];
		const answer = getAnswer(this.state, question.id);
		const active = index === this.state.activeOption;
		const selected = answer.selected.includes(option.value);
		const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
		const label = `${this.theme.fg(active ? "accent" : "text", option.label)}${selected ? this.theme.fg("success", " ✓") : ""}`;
		const lines = wrapWithPrefix(prefix, label, width);
		if (option.description) lines.push(...wrapWithPrefix("  ", this.theme.fg("muted", option.description), width));
		this.renderOptionNote(lines, question, option.value, width, "  ");
		return lines;
	}

	private renderMultiOption(question: NormalizedQuestion, index: number, width: number): string[] {
		if (this.isCustomIndex(question, index)) return this.renderCustomOption(question, true, width);

		const option = question.options[index];
		if (!option) return [];
		const answer = getAnswer(this.state, question.id);
		const active = index === this.state.activeOption;
		const selected = answer.selected.includes(option.value);
		const pointer = active ? this.theme.fg("accent", "→ ") : "  ";
		const box = selected ? "[x]" : this.theme.fg("dim", "[ ]");
		const label = this.theme.fg(active ? "accent" : "text", option.label);
		const lines = wrapWithPrefix(`${pointer}${box} `, label, width);
		if (option.description)
			lines.push(...wrapWithPrefix("      ", this.theme.fg("muted", option.description), width));
		this.renderOptionNote(lines, question, option.value, width, "      ");
		return lines;
	}

	private renderCustomOption(question: NormalizedQuestion, multi: boolean, width: number): string[] {
		const answer = getAnswer(this.state, question.id);
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
			`${this.theme.fg(active ? "accent" : "text", label)}${!multi && selected ? this.theme.fg("success", " ✓") : ""}`,
			width,
		);
	}

	private renderOptionNote(
		lines: string[],
		question: NormalizedQuestion,
		value: string,
		width: number,
		indent: string,
	): void {
		if (this.mode === "note" && this.noteTarget?.questionId === question.id && this.noteTarget.value === value) {
			renderNoteEditor(lines, this.editor, width, this.theme, indent);
			return;
		}
		const note = getAnswer(this.state, question.id).notes[value];
		if (note) pushSavedNote(lines, note, width, this.theme, indent);
	}

	private renderRecommendation(question: NormalizedQuestion, width: number): string[] {
		if (!question.recommendation) return [];
		const labels = question.recommendation.values.map(
			(value) => question.options.find((option) => option.value === value)?.label ?? value,
		);
		return [
			...wrapTextWithAnsi(
				`${this.theme.fg("muted", this.theme.bold("Recommendation: "))}${labels.join(", ")}`,
				width,
			),
			...wrapTextWithAnsi(
				this.theme.fg("muted", `${this.theme.bold("Reason: ")}${question.recommendation.reason}`),
				width,
			),
		];
	}

	private footer(width: number): string[] {
		const question = activeQuestion(this.state);
		const text =
			this.mode === "custom"
				? "Enter save • esc cancel edit"
				: this.mode === "note"
					? "Enter save • esc cancel note"
					: question?.kind === "input"
						? "type answer • enter next/submit • tab/←→ question • ctrl+s submit • ctrl+c abort"
						: question?.kind === "multi"
							? "↑↓ move • space toggle • enter next/submit • n note • tab/←→ question • ctrl+s submit • ctrl+c abort"
							: "↑↓ move • enter choose/submit • n note • tab/←→ question • ctrl+s submit • ctrl+c abort";
		return wrapTextWithAnsi(this.theme.fg("dim", text), width);
	}

	private handleQuestionInput(data: string, question: NormalizedQuestion): void {
		const input = this.getQuestionInput(question);
		if (matchesKey(data, Key.enter)) {
			this.state = saveInputAnswer(this.state, question, input.getValue());
			this.advance();
			return;
		}
		input.handleInput(data);
		this.state = saveInputAnswer(this.state, question, input.getValue());
		this.refresh();
	}

	private handleNoteInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.closeNote();
			return;
		}
		this.editor.handleInput(data);
		this.refresh();
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
		this.refresh();
	}

	private chooseActive(question: NormalizedQuestion): void {
		if (this.isCustomActive(question)) {
			this.openCustom(question, getAnswer(this.state, question.id).custom || "");
			this.refresh();
			return;
		}

		const option = question.options[this.state.activeOption];
		if (!option) return;
		this.state = toggleOrSelectOption(this.state, question, option.value);
		if (question.kind !== "multi") this.advance();
		else this.refresh();
	}

	private openNote(question: NormalizedQuestion): void {
		const option = question.options[this.state.activeOption];
		if (!option) return;
		this.noteTarget = { questionId: question.id, value: option.value };
		this.mode = "note";
		this.editor.setText(getAnswer(this.state, question.id).notes[option.value] || "");
		this.refresh();
	}

	private openCustom(question: NormalizedQuestion, value: string): void {
		this.mode = "custom";
		this.customQuestionId = question.id;
		this.customEditor.setText(value);
		this.customEditor.focused = this._focused;
	}

	private saveNote(value: string): void {
		const question = activeQuestion(this.state);
		if (question && this.noteTarget) {
			this.state = saveOptionNote(this.state, question, this.noteTarget.value, value);
		}
		this.closeNote();
	}

	private saveCustom(): void {
		const question = activeQuestion(this.state);
		if (!question) return;
		this.state = saveCustomAnswer(this.state, question, this.customEditor.getText());
		this.closeCustom(false);
		this.advance();
	}

	private closeNote(): void {
		this.mode = "navigate";
		this.noteTarget = undefined;
		this.editor.setText("");
		this.refresh();
	}

	private closeCustom(refresh = true): void {
		this.mode = "navigate";
		this.customQuestionId = undefined;
		this.customEditor.setText("");
		if (refresh) this.refresh();
	}

	private advance(): void {
		if (this.state.activeTab < this.state.questions.length - 1) {
			this.state = moveTab(this.state, 1);
			this.refresh();
			return;
		}
		this.done(buildResult(this.state));
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private getQuestionInput(question: NormalizedQuestion): Input {
		const existing = this.inputs.get(question.id);
		if (existing) return existing;
		const input = createInput(getAnswer(this.state, question.id).input || "");
		input.focused = this._focused;
		this.inputs.set(question.id, input);
		return input;
	}

	private isCustomActive(question: NormalizedQuestion): boolean {
		return this.isCustomIndex(question, this.state.activeOption);
	}

	private isCustomIndex(question: NormalizedQuestion, index: number): boolean {
		return hasCustom(question) && index === question.options.length;
	}
}

function editorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function createInput(value: string): Input {
	const input = new Input();
	if (value) input.handleInput(value);
	return input;
}

function renderInlineEditor(prefix: string, editor: Editor, width: number): string[] {
	const available = Math.max(1, width - visibleWidth(prefix));
	const lines = editorContentLines(editor.render(available));
	const contentLines = lines.length ? lines : [""];
	const continuation = " ".repeat(visibleWidth(prefix));
	return contentLines.map((line, index) =>
		truncateToWidth(`${index === 0 ? prefix : continuation}${line}`, width, ""),
	);
}

function renderNoteEditor(lines: string[], editor: Editor, width: number, theme: Theme, indent: string): void {
	const prefix = `${indent}${theme.fg("muted", "└─ ")}`;
	const available = Math.max(1, width - visibleWidth(prefix));
	const editorLines = editorContentLines(editor.render(available));
	const contentLines = editorLines.length ? editorLines : [""];
	lines.push(truncateToWidth(`${prefix}${contentLines[0] ?? ""}`, width, ""));
	const continuation = " ".repeat(visibleWidth(prefix));
	for (const line of contentLines.slice(1)) lines.push(truncateToWidth(`${continuation}${line}`, width, ""));
}

function pushSavedNote(lines: string[], note: string, width: number, theme: Theme, indent: string): void {
	for (const line of wrapWithPrefix(`${indent}${theme.fg("muted", "└─ ")}`, theme.fg("muted", note), width)) {
		lines.push(line);
	}
}

function wrapWithPrefix(prefix: string, text: string, width: number): string[] {
	const restWidth = Math.max(1, width - visibleWidth(prefix));
	return wrapTextWithAnsi(text, restWidth).map(
		(line, index) => `${index === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`,
	);
}

function editorContentLines(lines: string[]): string[] {
	if (lines.length <= 2) return lines;
	return lines.slice(1).filter((line) => !isEditorBorderLine(line));
}

function isEditorBorderLine(line: string): boolean {
	const text = stripAnsi(line).trim();
	return /^[┌┐└┘─]+$/.test(text) || /^─── [↑↓] \d+ more ─*$/.test(text);
}

function stripAnsi(text: string): string {
	let result = text;
	while (true) {
		const start = result.indexOf("\u001b[");
		if (start === -1) return result;
		const end = result.indexOf("m", start + 2);
		if (end === -1) return result;
		result = result.slice(0, start) + result.slice(end + 1);
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

function visibleTabRange(
	widths: number[],
	activeIndex: number,
	availableWidth: number,
): { start: number; end: number } {
	if (widths.length === 0) return { start: 0, end: -1 };
	const range = { start: activeIndex, end: activeIndex };
	let usedWidth = widths[activeIndex] ?? 0;
	let preferRight = activeIndex <= widths.length - activeIndex - 1;

	while (true) {
		const next = nextTab(widths, range, availableWidth, usedWidth, preferRight);
		if (!next) return range;
		usedWidth += 1 + next.width;
		if (next.direction === "left") range.start = next.index;
		else range.end = next.index;
		preferRight = !preferRight;
	}
}

function nextTab(
	widths: number[],
	range: { start: number; end: number },
	availableWidth: number,
	usedWidth: number,
	preferRight: boolean,
): { direction: "left" | "right"; index: number; width: number } | undefined {
	for (const direction of preferRight ? (["right", "left"] as const) : (["left", "right"] as const)) {
		const index = direction === "left" ? range.start - 1 : range.end + 1;
		const width = widths[index];
		if (width !== undefined && usedWidth + 1 + width <= availableWidth) return { direction, index, width };
	}
	return undefined;
}
