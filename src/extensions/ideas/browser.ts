import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { deleteIdea, type Idea, ideasFilePath, loadIdeas, updateIdea } from "./store.ts";

type BrowserAction =
	| { action: "cancel" }
	| { action: "insert"; idea: Idea }
	| { action: "delete"; idea: Idea }
	| { action: "edit"; idea: Idea };

export async function browseIdeas(ctx: ExtensionCommandContext): Promise<Idea | undefined> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Ideas browser requires TUI mode.", "error");
		return undefined;
	}

	const path = await ideasFilePath(ctx.cwd);

	while (true) {
		const ideas = await loadIdeas(ctx.cwd);
		const result = await showBrowser(ctx, ideas, path);

		if (result.action === "cancel") return undefined;
		if (result.action === "insert") return result.idea;

		if (result.action === "delete") {
			const ok = await ctx.ui.confirm("Delete idea?", result.idea.text);
			if (ok) {
				await deleteIdea(ctx.cwd, result.idea.id);
				ctx.ui.notify("Idea deleted.", "info");
			}
			continue;
		}

		// edit: native multiline editor, prefilled with the current text.
		const edited = await ctx.ui.editor("Edit idea", result.idea.text);
		if (edited == null) continue;
		if (!edited.trim()) {
			ctx.ui.notify("Edit cancelled (empty).", "info");
			continue;
		}
		await updateIdea(ctx.cwd, result.idea.id, edited);
		ctx.ui.notify("Idea updated.", "info");
	}
}

async function showBrowser(ctx: ExtensionCommandContext, ideas: readonly Idea[], path: string): Promise<BrowserAction> {
	return ctx.ui.custom<BrowserAction>(
		(tui, theme, _keybindings, done) => new IdeasBrowser(tui, theme, ideas, path, done),
	);
}

class IdeasBrowser implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly ideas: readonly Idea[];
	private readonly path: string;
	private readonly done: (action: BrowserAction) => void;
	private readonly search: Input;
	private cursor = 0;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, ideas: readonly Idea[], path: string, done: (action: BrowserAction) => void) {
		this.tui = tui;
		this.theme = theme;
		this.ideas = ideas;
		this.path = path;
		this.done = done;
		this.search = new Input();
		this.search.focused = true;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done({ action: "cancel" });
			return;
		}

		const current = this.filtered[this.cursor];

		if (matchesKey(data, Key.enter)) {
			if (current) this.done({ action: "insert", idea: current });
			return;
		}
		// ctrl-prefixed so plain typing always feeds the search box (no collision
		// with letters the user might want to search for).
		if (matchesKey(data, Key.ctrl("d"))) {
			if (current) this.done({ action: "delete", idea: current });
			return;
		}
		if (matchesKey(data, Key.ctrl("e"))) {
			if (current) this.done({ action: "edit", idea: current });
			return;
		}

		if (matchesKey(data, Key.up)) {
			if (this.cursor > 0) {
				this.cursor--;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.cursor < this.filtered.length - 1) {
				this.cursor++;
				this.tui.requestRender();
			}
			return;
		}

		this.search.handleInput(data);
		this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const filtered = this.filtered;
		const lines: string[] = [];

		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		const title = this.theme.fg("accent", this.theme.bold("Ideas"));
		const count = this.theme.fg("muted", `${this.ideas.length} total`);
		lines.push(truncateToWidth(`${title}  ${count}`, renderWidth, ""));
		lines.push(truncateToWidth(this.theme.fg("dim", this.path), renderWidth, ""));
		lines.push(...this.renderSearch(renderWidth));
		lines.push("");

		if (filtered.length === 0) {
			const message =
				this.ideas.length === 0 ? "No ideas yet. Use /ideas <text> to log one." : "No ideas match your search.";
			lines.push(...wrapTextWithAnsi(this.theme.fg("muted", message), renderWidth));
		} else {
			for (const [index, idea] of filtered.entries()) {
				lines.push(...this.renderItem(idea, index === this.cursor, renderWidth));
			}
		}

		lines.push("");
		lines.push(...this.renderHelp(renderWidth));
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		return lines;
	}

	invalidate(): void {}

	private get filtered(): Idea[] {
		const query = this.search.getValue().trim().toLowerCase();
		if (!query) return [...this.ideas];
		return this.ideas.filter((idea) => idea.text.toLowerCase().includes(query));
	}

	private renderSearch(width: number): string[] {
		const label = this.theme.fg("muted", "search: ");
		const labelWidth = visibleWidth("search: ");
		const body = this.search.render(Math.max(1, width - labelWidth));
		return [truncateToWidth(`${label}${body[0] ?? ""}`, width, "")];
	}

	private renderItem(idea: Idea, active: boolean, width: number): string[] {
		const pointer = active ? this.theme.fg("accent", "▶ ") : "  ";
		const label = this.theme.fg(active ? "accent" : "text", preview(idea.text));
		const age = this.theme.fg("dim", `  ${formatAge(idea.createdAt)}`);
		return [truncateToWidth(`${pointer}${label}${age}`, width, "")];
	}

	private renderHelp(width: number): string[] {
		return wrapTextWithAnsi(
			this.theme.fg("dim", "type to filter • ↑↓ move • enter insert • ctrl+e edit • ctrl+d delete • esc cancel"),
			width,
		);
	}
}

function preview(text: string, max = 80): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function formatAge(createdAt: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(createdAt).toISOString().slice(0, 10);
}
