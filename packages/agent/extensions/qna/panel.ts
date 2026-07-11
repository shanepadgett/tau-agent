import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { bindingHint, rawHint, type ToolKeyHint } from "@shanepadgett/tau-tui";
import { type TabItem, Tabs } from "@shanepadgett/tau-tui";
import { ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";
import { AdditionalContextBody } from "./additional-context-body.ts";
import { ChoiceQuestionBody } from "./choice-question-body.ts";
import { InputQuestionBody } from "./input-question-body.ts";
import {
	activeQuestion,
	buildResult,
	isAnswered,
	moveTab,
	type NormalizedQuestion,
	type QnaResult,
	type QnaState,
} from "./model.ts";

type QnaUiResult = QnaResult | undefined;

export class QnaPanel implements Component, Focusable {
	private readonly tui: TUI;
	private readonly done: (result: QnaUiResult) => void;
	private readonly choiceBody: ChoiceQuestionBody;
	private readonly inputBody: InputQuestionBody;
	private readonly additionalContextBody: AdditionalContextBody;
	private readonly tabs: Tabs;
	private readonly panelConfig: ToolPanelConfig;
	private readonly panel: ToolPanel;
	private state: QnaState;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, state: QnaState, done: (result: QnaUiResult) => void) {
		this.tui = tui;
		this.state = state;
		this.done = done;
		this.choiceBody = new ChoiceQuestionBody(
			tui,
			theme,
			() => this.state,
			(next) => this.setState(next),
			() => this.advance(),
		);
		this.inputBody = new InputQuestionBody(
			theme,
			() => this.state,
			(next) => this.setState(next),
			() => this.advance(),
		);
		this.additionalContextBody = new AdditionalContextBody(
			() => this.state,
			(next) => this.setState(next),
			() => this.submit(),
		);
		this.tabs = new Tabs(theme, this.tabItems(), this.activeTabId());
		this.panelConfig = {
			title: `qna: ${this.state.title || "Question"}`,
			body: this.tabs,
			footer: { kind: "hints", hints: this.footerHints() },
		};
		this.panel = new ToolPanel(theme, this.panelConfig);
		this.syncFocus();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}

		const active = this.activeBody();
		if (this.choiceBody.isEditing()) {
			this.choiceBody.handleInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.alt("enter"))) {
			this.submit();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.setState(moveTab(this.state, 1));
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.setState(moveTab(this.state, -1));
			return;
		}

		active.handleInput(data);
		this.refresh();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	private tabItems(): TabItem[] {
		return [
			...this.state.questions.map((question, index) => ({
				id: question.id,
				label: `${question.label}${isAnswered(this.state, question) ? "•" : ""}`,
				body: this.questionComponent(question, index),
			})),
			{
				id: "additional-context",
				label: `Additional Context${this.state.additionalContext ? "•" : ""}`,
				body: this.additionalContextBody,
			},
		];
	}

	private questionComponent(question: NormalizedQuestion, index: number): Component {
		return {
			render: (width) =>
				question.kind === "input"
					? this.inputBody.render(question, width)
					: this.choiceBody.render(question, width),
			invalidate: () => {},
			handleInput: (data) => {
				this.state = { ...this.state, activeTab: index };
				if (question.kind === "input") this.inputBody.forQuestion(question).handleInput(data);
				else this.choiceBody.forQuestion(question).handleInput(data);
			},
		};
	}

	private activeBody(): { handleInput(data: string): void; getKeyHints: () => readonly ToolKeyHint[] } {
		if (this.isAdditionalContextActive()) {
			return {
				handleInput: (data) => this.additionalContextBody.handleInput(data),
				getKeyHints: () => this.additionalContextHints(),
			};
		}
		const question = activeQuestion(this.state);
		if (question?.kind === "input") {
			this.inputBody.forQuestion(question);
			return {
				handleInput: (data) => this.inputBody.handleInput(data),
				getKeyHints: () => this.inputHints(),
			};
		}
		if (question) {
			this.choiceBody.forQuestion(question);
			return {
				handleInput: (data) => this.choiceBody.handleInput(data),
				getKeyHints: () => this.choiceHints(),
			};
		}
		return {
			handleInput: (data) => this.additionalContextBody.handleInput(data),
			getKeyHints: () => this.additionalContextHints(),
		};
	}

	private setState(state: QnaState): void {
		this.state = state;
		this.choiceBody.closeInactiveEditors();
		this.tabs.setTabs(this.tabItems());
		this.tabs.setActiveId(this.activeTabId());
		this.syncFocus();
		this.refresh();
	}

	private advance(): void {
		if (this.state.activeTab < this.state.questions.length) {
			this.setState(moveTab(this.state, 1));
			return;
		}
		this.submit();
	}

	private submit(): void {
		this.done(buildResult(this.state));
	}

	private syncFocus(): void {
		this.choiceBody.focused = false;
		this.inputBody.focused = false;
		this.additionalContextBody.focused = false;
		if (!this._focused) return;
		if (this.isAdditionalContextActive()) this.additionalContextBody.focused = true;
		else if (activeQuestion(this.state)?.kind === "input") this.inputBody.focused = true;
		else this.choiceBody.focused = true;
	}

	private footerHints(): readonly ToolKeyHint[] {
		return [
			...this.tabs.getKeyHints(),
			...this.activeBody().getKeyHints(),
			rawHint("Alt+Enter", "submit"),
			bindingHint("tui.select.cancel", "abort"),
		];
	}

	private inputHints(): readonly ToolKeyHint[] {
		return [bindingHint("tui.input.submit", "next")];
	}

	private additionalContextHints(): readonly ToolKeyHint[] {
		return [bindingHint("tui.input.submit", "submit")];
	}

	private choiceHints(): readonly ToolKeyHint[] {
		return this.choiceBody.keyHints();
	}

	private refresh(): void {
		this.panelConfig.footer = { kind: "hints", hints: this.footerHints() };
		this.tui.requestRender();
	}

	private activeTabId(): string {
		return this.isAdditionalContextActive()
			? "additional-context"
			: (activeQuestion(this.state)?.id ?? "additional-context");
	}

	private isAdditionalContextActive(): boolean {
		return this.state.activeTab === this.state.questions.length;
	}
}
