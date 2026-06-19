import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	type KeyId,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatAge, preview } from "../text.ts";

// Searchable single-select list over `{ id, text, createdAt }` records.
// Substring filter, viewport windowing, and configurable per-item actions
// (ctrl-prefixed so plain typing always feeds the search box). Backs the ideas
// and stash browsers; differs from pi's `SelectList`, which filters by prefix
// on `value` and owns a fixed two-column layout.

export interface SearchListItem {
	id: string;
	text: string;
	createdAt?: number;
}

export interface SearchListAction {
	id: string;
	key: KeyId;
	label: string;
}

export type SearchListResult<T extends SearchListItem = SearchListItem> =
	| { kind: "cancel" }
	| { kind: "primary"; item: T }
	| { kind: "action"; actionId: string; item: T };

export interface SearchListConfig {
	title: string;
	path?: string;
	emptyMessage: string;
	primaryLabel: string;
	actions: readonly SearchListAction[];
}

const MAX_VISIBLE = 12;

export class SearchList<T extends SearchListItem = SearchListItem> implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly items: readonly T[];
	private readonly config: SearchListConfig;
	private readonly done: (result: SearchListResult<T>) => void;
	private readonly search: Input;
	private cursor = 0;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		items: readonly T[],
		config: SearchListConfig,
		done: (result: SearchListResult<T>) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.items = items;
		this.config = config;
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
			this.done({ kind: "cancel" });
			return;
		}

		const current = this.filtered[this.cursor];

		if (matchesKey(data, Key.enter)) {
			if (current) this.done({ kind: "primary", item: current });
			return;
		}
		for (const action of this.config.actions) {
			if (matchesKey(data, action.key)) {
				if (current) this.done({ kind: "action", actionId: action.id, item: current });
				return;
			}
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
		const title = this.theme.fg("accent", this.theme.bold(this.config.title));
		const count = this.theme.fg("muted", `${this.items.length} total`);
		lines.push(truncateToWidth(`${title}  ${count}`, renderWidth, ""));
		if (this.config.path) {
			lines.push(truncateToWidth(this.theme.fg("dim", this.config.path), renderWidth, ""));
		}
		lines.push(...this.renderSearch(renderWidth));
		lines.push("");

		if (filtered.length === 0) {
			lines.push(...wrapTextWithAnsi(this.theme.fg("muted", this.config.emptyMessage), renderWidth));
		} else {
			const start = Math.max(0, Math.min(this.cursor - Math.floor(MAX_VISIBLE / 2), filtered.length - MAX_VISIBLE));
			const end = Math.min(filtered.length, start + MAX_VISIBLE);
			for (let i = start; i < end; i++) {
				lines.push(...this.renderItem(filtered[i]!, i === this.cursor, renderWidth));
			}
			if (start > 0 || end < filtered.length) {
				lines.push(this.theme.fg("dim", `  (${this.cursor + 1}/${filtered.length})`));
			}
		}

		lines.push("");
		lines.push(...this.renderHelp(renderWidth));
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		return lines;
	}

	invalidate(): void {}

	private get filtered(): T[] {
		const query = this.search.getValue().trim().toLowerCase();
		if (!query) return [...this.items];
		return this.items.filter((item) => item.text.toLowerCase().includes(query));
	}

	private renderSearch(width: number): string[] {
		const label = this.theme.fg("muted", "search: ");
		const labelWidth = visibleWidth("search: ");
		const body = this.search.render(Math.max(1, width - labelWidth));
		return [truncateToWidth(`${label}${body[0] ?? ""}`, width, "")];
	}

	private renderItem(item: SearchListItem, active: boolean, width: number): string[] {
		const pointer = active ? this.theme.fg("accent", "▶ ") : "  ";
		const label = this.theme.fg(active ? "accent" : "text", preview(item.text));
		const age = item.createdAt !== undefined ? this.theme.fg("dim", `  ${formatAge(item.createdAt)}`) : "";
		return [truncateToWidth(`${pointer}${label}${age}`, width, "")];
	}

	private renderHelp(width: number): string[] {
		const parts = [
			"type to filter",
			"↑↓ move",
			`enter ${this.config.primaryLabel}`,
			...this.config.actions.map((action) => action.label),
			"esc cancel",
		];
		return wrapTextWithAnsi(this.theme.fg("dim", parts.join(" • ")), width);
	}
}
