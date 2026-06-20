import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CommitFilePickerResult, CommitPlanGroup, DirtyFile } from "../types.ts";

interface PickerFile {
	file: DirtyFile;
	owner?: CommitPlanGroup;
}

export class CommitFilePicker implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly title: string;
	private readonly files: readonly DirtyFile[];
	private readonly groups: readonly CommitPlanGroup[];
	private readonly targetGroupId: string | undefined;
	private readonly done: (result: CommitFilePickerResult) => void;
	private readonly selected = new Set<string>();
	private readonly search = new Input();
	private cursor = 0;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		title: string,
		files: readonly DirtyFile[],
		groups: readonly CommitPlanGroup[],
		targetGroupId: string | undefined,
		initialFiles: readonly string[],
		preferUnassigned: boolean,
		done: (result: CommitFilePickerResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.title = title;
		this.files = preferUnassigned ? orderUnassignedFirst(files, groups) : files;
		this.groups = groups;
		this.targetGroupId = targetGroupId;
		this.done = done;
		for (const file of initialFiles) this.selected.add(file);
		this.search.focused = true;
	}

	get focused(): boolean {
		return Boolean(this._focused);
	}

	set focused(value: boolean) {
		this.search.focused = value;
		this._focused = value;
	}

	handleInput(data: string): void {
		if (this.handleCloseOrSave(data)) return;
		if (this.moveCursor(data)) return;
		if (this.toggleCurrent(data)) return;

		this.search.handleInput(data);
		this.clampCursor();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const titleLine = `${this.theme.bold(this.title)}  ${this.theme.fg("dim", `${this.selected.size} selected · ${this.files.length} files`)}`;
		const lines = [
			this.theme.fg("border", "─".repeat(renderWidth)),
			truncateToWidth(titleLine, renderWidth, ""),
			...this.renderSearch(renderWidth),
			"",
		];

		lines.push(...this.renderFileList(this.filtered, renderWidth));

		lines.push("");
		lines.push(
			...wrapTextWithAnsi(
				this.theme.fg("dim", "type to filter · ↑↓ move · space toggle · enter save · esc cancel"),
				renderWidth,
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		return lines;
	}

	invalidate(): void {}

	private get filtered(): PickerFile[] {
		const query = this.search.getValue().trim().toLowerCase();
		const files = this.files.map((file) => ({ file, owner: this.ownerFor(file.path) }));
		if (!query) return files;
		return files.filter((item) => filterText(item).includes(query));
	}

	private renderSearch(width: number): string[] {
		const body = this.search.render(Math.max(1, width - "search: ".length));
		return [truncateToWidth(`${this.theme.fg("muted", "search: ")}${body[0] ?? ""}`, width, "")];
	}

	private renderFileList(filtered: readonly PickerFile[], width: number): string[] {
		if (filtered.length === 0) return [this.theme.fg("muted", "  No matching files")];
		const maxVisible = 14;
		const start = Math.max(0, Math.min(this.cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible));
		const visible = filtered.slice(start, start + maxVisible);
		const lines = visible.flatMap((item, offset) => this.renderItem(item, start + offset === this.cursor, width));
		if (start > 0 || start + visible.length < filtered.length) {
			lines.push(this.theme.fg("dim", `  (${this.cursor + 1}/${filtered.length})`));
		}
		return lines;
	}

	private renderItem(item: PickerFile, active: boolean, width: number): string[] {
		const checked = this.selected.has(item.file.path);
		const pointer = active ? this.theme.fg("accent", "> ") : "  ";
		const box = checked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
		const owner = ownerLabel(item.owner, this.targetGroupId);
		const ownerText = owner ? this.theme.fg(owner.kind === "target" ? "success" : "muted", `  ${owner.text}`) : "";
		const path = active ? this.theme.bold(item.file.path) : item.file.path;
		return [
			truncateToWidth(`${pointer}${box} ${this.theme.fg("muted", item.file.status)} ${path}${ownerText}`, width, ""),
		];
	}

	private ownerFor(path: string): CommitPlanGroup | undefined {
		return this.groups.find((group) => group.files.includes(path));
	}

	private orderedSelectedFiles(): string[] {
		return this.files.map((file) => file.path).filter((path) => this.selected.has(path));
	}

	private handleCloseOrSave(data: string): boolean {
		if (matchesKey(data, Key.enter)) {
			this.done({ kind: "save", files: this.orderedSelectedFiles() });
			return true;
		}
		if (!matchesKey(data, Key.escape) && !matchesKey(data, Key.ctrl("c"))) return false;
		this.done({ kind: "cancel" });
		return true;
	}

	private moveCursor(data: string): boolean {
		const delta = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : 0;
		if (delta === 0) return false;
		this.cursor = Math.max(0, Math.min(this.filtered.length - 1, this.cursor + delta));
		this.tui.requestRender();
		return true;
	}

	private toggleCurrent(data: string): boolean {
		if (data !== " ") return false;
		const item = this.filtered[this.cursor];
		if (!item) return true;
		if (this.selected.has(item.file.path)) this.selected.delete(item.file.path);
		else this.selected.add(item.file.path);
		this.tui.requestRender();
		return true;
	}

	private clampCursor(): void {
		this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
	}
}

function orderUnassignedFirst(files: readonly DirtyFile[], groups: readonly CommitPlanGroup[]): DirtyFile[] {
	const owned = new Set(groups.flatMap((group) => group.files));
	return [...files].sort(
		(left, right) =>
			Number(owned.has(left.path)) - Number(owned.has(right.path)) || left.path.localeCompare(right.path),
	);
}

function filterText(item: PickerFile): string {
	return [item.file.path, item.file.status, item.owner?.message ?? "unassigned"].join(" ").toLowerCase();
}

function ownerLabel(
	owner: CommitPlanGroup | undefined,
	targetGroupId: string | undefined,
): { kind: "target" | "other"; text: string } | undefined {
	if (!owner) return undefined;
	if (targetGroupId && owner.id === targetGroupId) return { kind: "target", text: "current" };
	return { kind: "other", text: `currently: ${owner.message.split("\n")[0] ?? owner.message}` };
}
