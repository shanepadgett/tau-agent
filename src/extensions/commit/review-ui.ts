import { randomUUID } from "node:crypto";
import {
	type ExtensionCommandContext,
	type KeybindingsManager,
	keyHint,
	rawKeyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
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
import type { GitRunner } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";
import {
	type CommitGroup,
	type CommitPlanState,
	generatePlan,
	regenerateMessage,
	requireCommitMessage,
} from "./commit-plan.ts";
import {
	assertCommittableState,
	type CommitEvidence,
	computeWorktreeSignature,
	type DirtyFile,
	loadChangeSet,
} from "./git-change-set.ts";

const MAX_GROUPS = 10;
const MAX_ACTIVE_FILES = 8;
const MAX_PICKER_FILES = 14;

type ReviewAction =
	| { kind: "cancel" }
	| { kind: "execute" }
	| { kind: "editMessage"; groupId: string }
	| { kind: "assignFiles"; groupId: string }
	| { kind: "newGroup" }
	| { kind: "deleteGroup"; groupId: string }
	| { kind: "moveGroup"; groupId: string; direction: -1 | 1 }
	| { kind: "regenerateMessage"; groupId: string }
	| { kind: "regeneratePlan" };

type PickerResult = { kind: "cancel" } | { kind: "save"; files: string[] };
interface ReviewState {
	evidence: CommitEvidence;
	plan: CommitPlanState;
	selectedGroupId: string | undefined;
}

export async function reviewPlan(
	ctx: ExtensionCommandContext,
	git: GitRunner,
	root: string,
	evidence: CommitEvidence,
	initialPlan: CommitPlanState,
	initialSelectedGroupId: string | undefined,
	markerType: string,
): Promise<CommitPlanState | undefined> {
	let state: ReviewState = { evidence, plan: initialPlan, selectedGroupId: initialSelectedGroupId };
	while (true) {
		const action = await ctx.ui.custom<ReviewAction>((tui, theme, keybindings, done) =>
			commitPlanReview(tui, theme, keybindings, state.plan, state.selectedGroupId, done),
		);
		if (action.kind === "cancel") {
			ctx.ui.notify("Commit cancelled.", "info");
			return undefined;
		}
		if (action.kind === "execute") return state.plan;
		state = await applyReviewAction(ctx, git, root, state, action, markerType);
	}
}

async function applyReviewAction(
	ctx: ExtensionCommandContext,
	git: GitRunner,
	root: string,
	state: ReviewState,
	action: Exclude<ReviewAction, { kind: "cancel" } | { kind: "execute" }>,
	markerType: string,
): Promise<ReviewState> {
	switch (action.kind) {
		case "editMessage":
			return { ...state, ...(await editMessage(ctx, state.plan, action.groupId)) };
		case "assignFiles":
			return { ...state, ...(await assignFiles(ctx, state.plan, action.groupId)) };
		case "newGroup":
			return { ...state, ...(await newGroup(ctx, state.evidence, state.plan)) };
		case "deleteGroup":
			return {
				...state,
				...selectFirst({ ...state.plan, groups: state.plan.groups.filter((group) => group.id !== action.groupId) }),
			};
		case "moveGroup":
			return {
				...state,
				plan: moveGroup(state.plan, action.groupId, action.direction),
				selectedGroupId: action.groupId,
			};
		case "regenerateMessage":
			return { ...state, ...(await regenerateSelectedMessage(ctx, state.evidence, state.plan, action.groupId)) };
		case "regeneratePlan":
			return regenerateWholePlan(ctx, git, root, state, markerType);
	}
}

async function editMessage(
	ctx: ExtensionCommandContext,
	plan: CommitPlanState,
	groupId: string,
): Promise<Pick<ReviewState, "plan" | "selectedGroupId">> {
	const group = plan.groups.find((item) => item.id === groupId);
	if (!group) return selectFirst(plan);
	const edited = await ctx.ui.editor("Edit commit message", group.message);
	if (!edited?.trim()) return { plan, selectedGroupId: groupId };
	try {
		return { plan: setMessage(plan, groupId, requireCommitMessage(edited)), selectedGroupId: groupId };
	} catch (error) {
		ctx.ui.notify(`Invalid commit message: ${errorText(error)}`, "error");
		return { plan, selectedGroupId: groupId };
	}
}

async function assignFiles(
	ctx: ExtensionCommandContext,
	plan: CommitPlanState,
	groupId: string,
): Promise<Pick<ReviewState, "plan" | "selectedGroupId">> {
	const group = plan.groups.find((item) => item.id === groupId);
	if (!group) return selectFirst(plan);
	const files = await pickFiles(ctx, `Assign files to: ${subjectLine(group.message)}`, plan, group.id, group.files);
	return files
		? { plan: assignSelectedFiles(plan, group.id, files), selectedGroupId: group.id }
		: { plan, selectedGroupId: group.id };
}

async function newGroup(
	ctx: ExtensionCommandContext,
	evidence: CommitEvidence,
	plan: CommitPlanState,
): Promise<Pick<ReviewState, "plan" | "selectedGroupId">> {
	const files = await pickFiles(ctx, "New commit: select files", plan, undefined, unassignedFiles(plan));
	if (!files) return selectFirst(plan);
	if (files.length === 0) {
		ctx.ui.notify("No files selected.", "info");
		return selectFirst(plan);
	}
	const edited = await ctx.ui.editor("New commit message (empty = auto-generate)", "");
	if (edited === undefined) return selectFirst(plan);
	const message = await commitMessageForSelection(ctx, evidence, files, edited);
	if (!message) return selectFirst(plan);
	const group = { id: randomUUID(), message, files };
	return { plan: addGroup(plan, group), selectedGroupId: group.id };
}

async function commitMessageForSelection(
	ctx: ExtensionCommandContext,
	evidence: CommitEvidence,
	files: readonly string[],
	edited: string,
): Promise<string | undefined> {
	if (!edited.trim()) return regenerateMessage(ctx, evidence, files);
	try {
		return requireCommitMessage(edited);
	} catch (error) {
		ctx.ui.notify(`Invalid commit message: ${errorText(error)}`, "error");
		return undefined;
	}
}

async function regenerateSelectedMessage(
	ctx: ExtensionCommandContext,
	evidence: CommitEvidence,
	plan: CommitPlanState,
	groupId: string,
): Promise<Pick<ReviewState, "plan" | "selectedGroupId">> {
	const group = plan.groups.find((item) => item.id === groupId);
	if (!group) return selectFirst(plan);
	const note = await ctx.ui.editor("Regeneration note (optional)", "");
	if (note === undefined) return { plan, selectedGroupId: group.id };
	const message = await regenerateMessage(ctx, evidence, group.files, plan.groups, group.id, note);
	return { plan: setMessage(plan, group.id, message), selectedGroupId: group.id };
}

async function regenerateWholePlan(
	ctx: ExtensionCommandContext,
	git: GitRunner,
	root: string,
	state: ReviewState,
	markerType: string,
): Promise<ReviewState> {
	const note = await ctx.ui.editor("Regeneration note (optional)", "");
	if (note === undefined) return state;
	const evidence = await loadChangeSet(git, root, ctx.sessionManager.getBranch(), markerType);
	assertCommittableState(evidence.files);
	const plan = {
		files: evidence.files,
		worktreeSignature: await computeWorktreeSignature(git, root, evidence.files),
		groups: await generatePlan(ctx, evidence, state.plan.groups, note),
	};
	return { evidence, plan, selectedGroupId: plan.groups[0]?.id };
}

async function pickFiles(
	ctx: ExtensionCommandContext,
	title: string,
	plan: CommitPlanState,
	targetGroupId: string | undefined,
	initialFiles: readonly string[],
): Promise<string[] | undefined> {
	const result = await ctx.ui.custom<PickerResult>((tui, theme, keybindings, done) =>
		commitFilePicker(tui, theme, keybindings, title, plan, targetGroupId, initialFiles, done),
	);
	return result.kind === "save" ? result.files : undefined;
}

function commitPlanReview(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	plan: CommitPlanState,
	selectedGroupId: string | undefined,
	done: (action: ReviewAction) => void,
): Component {
	let cursor = Math.max(0, selectedGroupId ? plan.groups.findIndex((group) => group.id === selectedGroupId) : -1);
	const fileByPath = new Map(plan.files.map((file) => [file.path, file]));
	const moveCursor = (data: string): boolean => {
		const delta = keybindings.matches(data, "tui.select.up")
			? -1
			: keybindings.matches(data, "tui.select.down")
				? 1
				: 0;
		if (delta === 0) return false;
		cursor = clamp(cursor + delta, 0, Math.max(0, plan.groups.length - 1));
		tui.requestRender();
		return true;
	};
	const finish = (action: ReviewAction): void => done(action);
	return {
		handleInput(data: string): void {
			if (keybindings.matches(data, "tui.select.confirm")) {
				finish({ kind: "execute" });
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				finish({ kind: "cancel" });
				return;
			}
			if (moveCursor(data)) return;
			if (data === "n") {
				finish({ kind: "newGroup" });
				return;
			}
			if (data === "R") {
				finish({ kind: "regeneratePlan" });
				return;
			}
			const group = plan.groups[cursor];
			if (!group) return;
			if (data === "e") finish({ kind: "editMessage", groupId: group.id });
			else if (data === "a") finish({ kind: "assignFiles", groupId: group.id });
			else if (data === "r") finish({ kind: "regenerateMessage", groupId: group.id });
			else if (data === "[") finish({ kind: "moveGroup", groupId: group.id, direction: -1 });
			else if (data === "]") finish({ kind: "moveGroup", groupId: group.id, direction: 1 });
			else if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace))
				finish({ kind: "deleteGroup", groupId: group.id });
		},
		render(width: number): string[] {
			const renderWidth = Math.max(1, width);
			const visible = visibleWindow(plan.groups, cursor, MAX_GROUPS);
			return [
				theme.fg("border", "─".repeat(renderWidth)),
				truncateToWidth(
					`${theme.bold("Commit plan")}  ${theme.fg("dim", `${plan.groups.length} commits · ${plan.files.length} files`)}`,
					renderWidth,
					"",
				),
				"",
				...visible.items.flatMap(({ item, index }) =>
					renderGroup(theme, fileByPath, item, index, index === cursor, renderWidth),
				),
				...positionLine(theme, visible.start, visible.items.length, plan.groups.length),
				...unassignedLine(theme, plan),
				"",
				...reviewHelp(theme, renderWidth),
				theme.fg("border", "─".repeat(renderWidth)),
			];
		},
		invalidate(): void {},
	};
}

function commitFilePicker(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	title: string,
	plan: CommitPlanState,
	targetGroupId: string | undefined,
	initialFiles: readonly string[],
	done: (result: PickerResult) => void,
): Component & Focusable {
	const files = orderPickerFiles(plan, targetGroupId, initialFiles);
	const ownerByPath = new Map(plan.groups.flatMap((group) => group.files.map((file) => [file, group] as const)));
	const selected = new Set(initialFiles);
	const search = new Input();
	let cursor = 0;
	let focused = false;
	search.focused = true;

	const filtered = (): DirtyFile[] => {
		const query = search.getValue().trim().toLowerCase();
		return query
			? files.filter((file) =>
					`${file.path} ${file.status} ${ownerByPath.get(file.path)?.message ?? "unassigned"}`
						.toLowerCase()
						.includes(query),
				)
			: [...files];
	};
	const moveCursor = (data: string): boolean => {
		const delta = keybindings.matches(data, "tui.select.up")
			? -1
			: keybindings.matches(data, "tui.select.down")
				? 1
				: 0;
		if (delta === 0) return false;
		cursor = clamp(cursor + delta, 0, Math.max(0, filtered().length - 1));
		tui.requestRender();
		return true;
	};
	return {
		get focused(): boolean {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			search.focused = value;
		},
		handleInput(data: string): void {
			if (keybindings.matches(data, "tui.select.confirm")) {
				done({ kind: "save", files: files.map((file) => file.path).filter((path) => selected.has(path)) });
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				done({ kind: "cancel" });
				return;
			}
			if (moveCursor(data)) return;
			if (matchesKey(data, Key.space)) {
				const file = filtered()[cursor];
				if (file && selected.has(file.path)) selected.delete(file.path);
				else if (file) selected.add(file.path);
				tui.requestRender();
				return;
			}
			search.handleInput(data);
			cursor = Math.min(cursor, Math.max(0, filtered().length - 1));
			tui.requestRender();
		},
		render(width: number): string[] {
			const renderWidth = Math.max(1, width);
			const current = filtered();
			const visible = visibleWindow(current, cursor, MAX_PICKER_FILES);
			return [
				theme.fg("border", "─".repeat(renderWidth)),
				truncateToWidth(
					`${theme.bold(title)}  ${theme.fg("dim", `${selected.size} selected · ${files.length} files`)}`,
					renderWidth,
					"",
				),
				...renderSearch(theme, search, renderWidth),
				"",
				...(current.length === 0
					? [theme.fg("muted", "  No matching files")]
					: visible.items.map(({ item, index }) =>
							renderPickerItem(theme, ownerByPath, targetGroupId, selected, item, index === cursor, renderWidth),
						)),
				...positionLine(theme, visible.start, visible.items.length, current.length),
				"",
				...pickerHelp(theme, renderWidth),
				theme.fg("border", "─".repeat(renderWidth)),
			];
		},
		invalidate(): void {},
	};
}

function renderGroup(
	theme: Theme,
	fileByPath: ReadonlyMap<string, DirtyFile>,
	group: CommitGroup,
	index: number,
	active: boolean,
	width: number,
): string[] {
	const pointer = active ? theme.fg("accent", "> ") : "  ";
	const title = active ? theme.bold(subjectLine(group.message)) : subjectLine(group.message);
	const lines = [
		truncateToWidth(`${pointer}${index + 1}  ${title}${theme.fg("dim", `  ${group.files.length} files`)}`, width, ""),
	];
	if (!active) return lines;
	for (const path of group.files.slice(0, MAX_ACTIVE_FILES))
		lines.push(truncateToWidth(`     ${theme.fg("muted", fileByPath.get(path)?.status ?? "??")} ${path}`, width, ""));
	if (group.files.length > MAX_ACTIVE_FILES)
		lines.push(theme.fg("dim", `     … ${group.files.length - MAX_ACTIVE_FILES} more`));
	return lines;
}

function renderPickerItem(
	theme: Theme,
	ownerByPath: ReadonlyMap<string, CommitGroup>,
	targetGroupId: string | undefined,
	selected: ReadonlySet<string>,
	file: DirtyFile,
	active: boolean,
	width: number,
): string {
	const pointer = active ? theme.fg("accent", "> ") : "  ";
	const box = selected.has(file.path) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
	const path = active ? theme.bold(file.path) : file.path;
	return truncateToWidth(
		`${pointer}${box} ${theme.fg("muted", file.status)} ${path}${ownerHint(theme, ownerByPath.get(file.path), targetGroupId)}`,
		width,
		"",
	);
}

function ownerHint(theme: Theme, owner: CommitGroup | undefined, targetGroupId: string | undefined): string {
	if (!owner) return "";
	const text = owner.id === targetGroupId ? "current" : `currently: ${subjectLine(owner.message)}`;
	return theme.fg(owner.id === targetGroupId ? "success" : "muted", `  ${text}`);
}

function renderSearch(theme: Theme, search: Input, width: number): string[] {
	const body = search.render(Math.max(1, width - "search: ".length));
	return [truncateToWidth(`${theme.fg("muted", "search: ")}${body[0] ?? ""}`, width, "")];
}

function positionLine(theme: Theme, start: number, count: number, total: number): string[] {
	return total > count ? [theme.fg("dim", `  (${start + 1}-${start + count}/${total})`)] : [];
}

function unassignedLine(theme: Theme, plan: CommitPlanState): string[] {
	const count = unassignedFiles(plan).length;
	return count > 0 ? ["", theme.fg("warning", `  ${count} unassigned file(s)`)] : [];
}

function reviewHelp(theme: Theme, width: number): string[] {
	return wrapTextWithAnsi(
		theme.fg(
			"dim",
			[
				keyHint("tui.select.up", "move"),
				rawKeyHint("e", "edit"),
				rawKeyHint("a", "assign"),
				rawKeyHint("n", "new"),
				rawKeyHint("r", "regen"),
				rawKeyHint("shift+r", "regen plan"),
				rawKeyHint("[", "up"),
				rawKeyHint("]", "down"),
				rawKeyHint("delete", "delete"),
				keyHint("tui.select.confirm", "commit"),
				keyHint("tui.select.cancel", "cancel"),
			].join(" · "),
		),
		width,
	);
}

function pickerHelp(theme: Theme, width: number): string[] {
	return wrapTextWithAnsi(
		theme.fg(
			"dim",
			[
				"type to filter",
				keyHint("tui.select.up", "move"),
				rawKeyHint("space", "toggle"),
				keyHint("tui.select.confirm", "save"),
				keyHint("tui.select.cancel", "cancel"),
			].join(" · "),
		),
		width,
	);
}

function setMessage(plan: CommitPlanState, groupId: string, message: string): CommitPlanState {
	return { ...plan, groups: plan.groups.map((group) => (group.id === groupId ? { ...group, message } : group)) };
}

function assignSelectedFiles(plan: CommitPlanState, groupId: string, files: readonly string[]): CommitPlanState {
	const selected = new Set(files);
	return {
		...plan,
		groups: plan.groups.map((group) =>
			group.id === groupId
				? { ...group, files: [...selected] }
				: { ...group, files: group.files.filter((file) => !selected.has(file)) },
		),
	};
}

function addGroup(plan: CommitPlanState, group: CommitGroup): CommitPlanState {
	const selected = new Set(group.files);
	return {
		...plan,
		groups: [
			...plan.groups.map((item) => ({ ...item, files: item.files.filter((file) => !selected.has(file)) })),
			group,
		],
	};
}

function moveGroup(plan: CommitPlanState, groupId: string, direction: -1 | 1): CommitPlanState {
	const groups = [...plan.groups];
	const index = groups.findIndex((group) => group.id === groupId);
	const target = index + direction;
	const moving = groups[index];
	if (!moving || target < 0 || target >= groups.length) return plan;
	groups.splice(index, 1);
	groups.splice(target, 0, moving);
	return { ...plan, groups };
}

function selectFirst(plan: CommitPlanState): Pick<ReviewState, "plan" | "selectedGroupId"> {
	return { plan, selectedGroupId: plan.groups[0]?.id };
}

function unassignedFiles(plan: CommitPlanState): string[] {
	const assigned = new Set(plan.groups.flatMap((group) => group.files));
	return plan.files.filter((file) => !assigned.has(file.path)).map((file) => file.path);
}

function orderPickerFiles(
	plan: CommitPlanState,
	targetGroupId: string | undefined,
	initialFiles: readonly string[],
): DirtyFile[] {
	const initial = new Set(initialFiles);
	const assigned = new Set(plan.groups.flatMap((group) => group.files));
	return [...plan.files].sort(
		(left, right) =>
			rankPickerFile(left.path, targetGroupId, initial, assigned) -
				rankPickerFile(right.path, targetGroupId, initial, assigned) || left.path.localeCompare(right.path),
	);
}

function rankPickerFile(
	path: string,
	targetGroupId: string | undefined,
	initial: ReadonlySet<string>,
	assigned: ReadonlySet<string>,
): number {
	if (initial.has(path)) return 0;
	if (!targetGroupId && !assigned.has(path)) return 1;
	return 2;
}

function visibleWindow<T>(
	items: readonly T[],
	cursor: number,
	maxVisible: number,
): { start: number; items: { item: T; index: number }[] } {
	const start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), items.length - maxVisible));
	return {
		start,
		items: items.slice(start, start + maxVisible).map((item, offset) => ({ item, index: start + offset })),
	};
}

function subjectLine(message: string): string {
	return message.split("\n")[0] ?? message;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
