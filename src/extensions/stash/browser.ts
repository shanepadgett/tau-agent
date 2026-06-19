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
import { loadStashes, removeStash, type Stash, stashFilePath } from "./store.ts";

type BrowserAction = { action: "cancel" } | { action: "pop"; stash: Stash } | { action: "discard"; stash: Stash };

export async function browseStash(ctx: ExtensionCommandContext): Promise<Stash | undefined> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Stash browser requires TUI mode.", "error");
		return undefined;
	}

	const path = await stashFilePath(ctx.cwd);

	while (true) {
		const stashes = await loadStashes(ctx.cwd);
		const result = await showBrowser(ctx, stashes, path);

		if (result.action === "cancel") return undefined;
		if (result.action === "pop") return result.stash;

		// discard: drop the stashed prompt without restoring it.
		const ok = await ctx.ui.confirm("Discard stashed prompt?", result.stash.text);
		if (ok) {
			await removeStash(ctx.cwd, result.stash.id);
			ctx.ui.notify("Stash discarded.", "info");
		}
	}
}

async function showBrowser(
	ctx: ExtensionCommandContext,
	stashes: readonly Stash[],
	path: string,
): Promise<BrowserAction> {
	return ctx.ui.custom<BrowserAction>(
		(tui, theme, _keybindings, done) => new StashBrowser(tui, theme, stashes, path, done),
	);
}

class StashBrowser implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly stashes: readonly Stash[];
	private readonly path: string;
	private readonly done: (action: BrowserAction) => void;
	private readonly search: Input;
	private cursor = 0;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, stashes: readonly Stash[], path: string, done: (action: BrowserAction) => void) {
		this.tui = tui;
		this.theme = theme;
		this.stashes = stashes;
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
			if (current) this.done({ action: "pop", stash: current });
			return;
		}
		// ctrl-prefixed so plain typing always feeds the search box (no collision
		// with letters the user might want to search for).
		if (matchesKey(data, Key.ctrl("d"))) {
			if (current) this.done({ action: "discard", stash: current });
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
		const title = this.theme.fg("accent", this.theme.bold("Stash"));
		const count = this.theme.fg("muted", `${this.stashes.length} total`);
		lines.push(truncateToWidth(`${title}  ${count}`, renderWidth, ""));
		lines.push(truncateToWidth(this.theme.fg("dim", this.path), renderWidth, ""));
		lines.push(...this.renderSearch(renderWidth));
		lines.push("");

		if (filtered.length === 0) {
			const message =
				this.stashes.length === 0
					? "No stashed prompts. Use ctrl+shift+s while typing to stash."
					: "No stashes match your search.";
			lines.push(...wrapTextWithAnsi(this.theme.fg("muted", message), renderWidth));
		} else {
			for (const [index, stash] of filtered.entries()) {
				lines.push(...this.renderItem(stash, index === this.cursor, renderWidth));
			}
		}

		lines.push("");
		lines.push(...this.renderHelp(renderWidth));
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		return lines;
	}

	invalidate(): void {}

	private get filtered(): Stash[] {
		const query = this.search.getValue().trim().toLowerCase();
		if (!query) return [...this.stashes];
		return this.stashes.filter((stash) => stash.text.toLowerCase().includes(query));
	}

	private renderSearch(width: number): string[] {
		const label = this.theme.fg("muted", "search: ");
		const labelWidth = visibleWidth("search: ");
		const body = this.search.render(Math.max(1, width - labelWidth));
		return [truncateToWidth(`${label}${body[0] ?? ""}`, width, "")];
	}

	private renderItem(stash: Stash, active: boolean, width: number): string[] {
		const pointer = active ? this.theme.fg("accent", "▶ ") : "  ";
		const label = this.theme.fg(active ? "accent" : "text", preview(stash.text));
		const age = this.theme.fg("dim", `  ${formatAge(stash.createdAt)}`);
		return [truncateToWidth(`${pointer}${label}${age}`, width, "")];
	}

	private renderHelp(width: number): string[] {
		return wrapTextWithAnsi(
			this.theme.fg("dim", "type to filter • ↑↓ move • enter pop into editor • ctrl+d discard • esc cancel"),
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
