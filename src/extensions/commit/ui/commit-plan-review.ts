import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { unassignedFiles } from "../planner.ts";
import type { CommitPlanReviewAction, CommitPlanState, DirtyFile } from "../types.ts";

const MAX_VISIBLE_LINES = 18;

export class CommitPlanReview implements Component {
	private readonly theme: Theme;
	private readonly state: CommitPlanState;
	private readonly done: (action: CommitPlanReviewAction) => void;
	private cursor = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		theme: Theme,
		state: CommitPlanState,
		selectedGroupId: string | undefined,
		done: (action: CommitPlanReviewAction) => void,
	) {
		this.theme = theme;
		this.state = state;
		this.done = done;
		const index = selectedGroupId ? state.groups.findIndex((group) => group.id === selectedGroupId) : -1;
		this.cursor = Math.max(0, index);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.done({ kind: "execute" });
			return;
		}
		if (this.isCancelKey(data)) {
			this.done({ kind: "cancel" });
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.cursor = Math.min(Math.max(0, this.state.groups.length - 1), this.cursor + 1);
			this.invalidate();
			return;
		}
		if (data === "n") {
			this.done({ kind: "newGroup" });
			return;
		}
		if (data === "R") {
			this.done({ kind: "regeneratePlan" });
			return;
		}

		const group = this.selectedGroup();
		if (!group) return;
		if (data === "e") this.done({ kind: "editMessage", groupId: group.id });
		else if (data === "a") this.done({ kind: "assignFiles", groupId: group.id });
		else if (data === "r") this.done({ kind: "regenerateMessage", groupId: group.id });
		else if (data === "[") this.done({ kind: "moveGroup", groupId: group.id, direction: -1 });
		else if (data === "]") this.done({ kind: "moveGroup", groupId: group.id, direction: 1 });
		else if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace))
			this.done({ kind: "deleteGroup", groupId: group.id });
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const renderWidth = Math.max(1, width);
		const unassigned = unassignedFiles(this.state.files, this.state.groups);
		const lines: string[] = [];
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		lines.push(
			truncateToWidth(
				`${this.theme.bold("Semantic commit plan")}  ${this.theme.fg("dim", `${this.state.groups.length} commits · ${this.state.files.length} files · ${unassigned.length} unassigned`)}`,
				renderWidth,
				"",
			),
		);
		lines.push("");

		const body = this.renderBody(renderWidth, unassigned);
		const visible = windowLines(body.lines, body.groupHeaderLines, this.cursor, MAX_VISIBLE_LINES);
		lines.push(...visible.lines);
		if (visible.hidden > 0) lines.push(this.theme.fg("dim", `  (${visible.hidden} more lines hidden; ↑↓ to scroll)`));

		lines.push("");
		if (this.state.groups.some((group) => group.files.length === 0)) {
			lines.push(this.theme.fg("warning", " Empty commits are blocked before execution."));
		}
		lines.push(
			...wrapTextWithAnsi(
				this.theme.fg(
					"dim",
					"↑↓ move · e edit · a assign · n new · r regen msg · R regen plan · [/] reorder · del delete · enter commit · esc cancel",
				),
				renderWidth,
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderBody(
		width: number,
		unassigned: readonly DirtyFile[],
	): {
		lines: string[];
		groupHeaderLines: number[];
	} {
		const lines: string[] = [];
		const groupHeaderLines: number[] = [];
		if (this.state.groups.length === 0) lines.push(this.theme.fg("warning", "  No commit groups."));
		for (const [index, group] of this.state.groups.entries()) {
			groupHeaderLines.push(lines.length);
			const active = index === this.cursor;
			const pointer = active ? this.theme.fg("accent", "> ") : "  ";
			const title = `${index + 1}  ${group.message}`;
			const count = this.theme.fg("dim", `  ${group.files.length} files`);
			lines.push(truncateToWidth(`${pointer}${active ? this.theme.bold(title) : title}${count}`, width, ""));
			for (const path of group.files.slice(0, active ? 8 : 3)) {
				const file = this.state.files.find((item) => item.path === path);
				lines.push(truncateToWidth(`     ${this.theme.fg("muted", file?.status ?? "??")} ${path}`, width, ""));
			}
			if (group.files.length > (active ? 8 : 3))
				lines.push(this.theme.fg("dim", `     … ${group.files.length - (active ? 8 : 3)} more`));
			if (active && group.rationale)
				lines.push(...wrapTextWithAnsi(`     ${this.theme.fg("dim", group.rationale)}`, width));
			lines.push("");
		}

		if (unassigned.length > 0) {
			lines.push(this.theme.fg("warning", `  Unassigned (${unassigned.length})`));
			for (const file of unassigned.slice(0, 6)) {
				lines.push(truncateToWidth(`     ${this.theme.fg("muted", file.status)} ${file.path}`, width, ""));
			}
			if (unassigned.length > 6) lines.push(this.theme.fg("dim", `     … ${unassigned.length - 6} more`));
		}
		return { lines, groupHeaderLines };
	}

	private selectedGroup(): { id: string } | undefined {
		return this.state.groups[this.cursor];
	}

	private isCancelKey(data: string): boolean {
		return matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
	}
}

// Window body lines so the active group's header stays in view, centered when
// possible. `groupHeaderLines[i]` is the body line index where group i's header
// was emitted.
function windowLines(
	body: readonly string[],
	groupHeaderLines: readonly number[],
	cursor: number,
	maxVisible: number,
): { lines: string[]; hidden: number } {
	if (body.length <= maxVisible) return { lines: [...body], hidden: 0 };
	const headerLine = groupHeaderLines[cursor] ?? 0;
	const half = Math.floor(maxVisible / 2);
	const start = Math.max(0, Math.min(headerLine - half, body.length - maxVisible));
	const slice = body.slice(start, start + maxVisible);
	return { lines: slice, hidden: body.length - slice.length };
}
