import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type Focusable,
	Key,
	type KeybindingsManager,
	matchesKey,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	bindingHint,
	bindingsHint,
	editorTheme,
	pushSavedNote,
	rawHint,
	renderNoteEditor,
	ScrollableMarkdown,
	ToolPanel,
	type ToolPanelConfig,
	wrapWithPrefix,
} from "@shanepadgett/tau-tui";

export type ApprovalChoice = "approve" | "reject";
export interface ApprovalAnswer {
	choice: ApprovalChoice;
	note: string;
}

export class ToolApprovalPanel implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (answer: ApprovalAnswer | undefined) => void;
	private readonly noteEditor: Editor;
	private readonly panelConfig: ToolPanelConfig;
	private readonly panel: ToolPanel;
	private readonly sourceView: ScrollableMarkdown | undefined;
	private readonly notes: Record<ApprovalChoice, string> = { approve: "", reject: "" };
	private choice: ApprovalChoice = "approve";
	private editing = false;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		title: string,
		body: string,
		scriptSource: string | undefined,
		done: (answer: ApprovalAnswer | undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.noteEditor = new Editor(tui, editorTheme(theme));
		this.noteEditor.onSubmit = (value) => {
			this.notes[this.choice] = value.trim();
			this.closeNote();
		};
		if (scriptSource !== undefined) {
			const fenceLength = (scriptSource.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length + 1), 3);
			const fence = "`".repeat(fenceLength);
			this.sourceView = new ScrollableMarkdown(tui, `${fence}\n${scriptSource}\n${fence}`, 14);
		}
		this.panelConfig = {
			title,
			secondary: "Approve runs this request as shown. To change it, reject with a note.",
			header: [body],
			body: { render: (width) => this.renderChoices(width), invalidate: () => this.sourceView?.invalidate() },
			footer: { kind: "hints", hints: this.hints() },
		};
		this.panel = new ToolPanel(theme, this.panelConfig);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.noteEditor.focused = value && this.editing;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}
		if (this.editing) {
			if (this.keys.matches(data, "tui.select.cancel")) this.closeNote();
			else this.noteEditor.handleInput(data);
			this.refresh();
			return;
		}
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (this.sourceView && (data === "j" || data === "k")) {
			this.sourceView.scroll(data === "j" ? 1 : -1);
		} else if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")) {
			this.choice = this.choice === "approve" ? "reject" : "approve";
		} else if (data === "n") {
			this.editing = true;
			this.noteEditor.setText(this.notes[this.choice]);
			this.focused = this._focused;
		} else if (this.keys.matches(data, "tui.select.confirm")) {
			this.done({ choice: this.choice, note: this.notes[this.choice] });
			return;
		}
		this.refresh();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	private renderChoices(width: number): string[] {
		const lines: string[] = [];
		if (this.sourceView) {
			lines.push(this.theme.fg("muted", "Complete script:"), ...this.sourceView.render(width), "");
		}
		for (const choice of ["approve", "reject"] as const) {
			const selected = choice === this.choice;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			lines.push(
				...wrapWithPrefix(
					prefix,
					this.theme.fg(selected ? "accent" : "text", choice === "approve" ? "Approve" : "Reject"),
					width,
				),
			);
			if (this.editing && selected) renderNoteEditor(lines, this.noteEditor, width, this.theme, "  ");
			else if (this.notes[choice]) pushSavedNote(lines, this.notes[choice], width, this.theme, "  ");
		}
		return lines;
	}

	private closeNote(): void {
		this.editing = false;
		this.noteEditor.setText("");
		this.focused = this._focused;
	}

	private hints() {
		return this.editing
			? [bindingHint("tui.input.submit", "save"), bindingHint("tui.select.cancel", "cancel note")]
			: [
					bindingsHint(["tui.select.up", "tui.select.down"], "move"),
					...(this.sourceView ? [rawHint("j/k", "scroll script")] : []),
					bindingHint("tui.select.confirm", "choose"),
					rawHint("n", "note"),
					bindingHint("tui.select.cancel", "block"),
				];
	}

	private refresh(): void {
		this.panelConfig.footer = { kind: "hints", hints: this.hints() };
		this.tui.requestRender();
	}
}
