import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type Focusable,
	getKeybindings,
	Input,
	Key,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { GitRunner } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";
import { editorTheme } from "../../shared/tui/editor-theme.ts";
import { bindingHint, rawHint, type ToolKeyHint } from "../../shared/tui/key-hints.ts";
import {
	SelectableList,
	type SelectableListItem,
	type SelectableListResult,
} from "../../shared/tui/selectable-list.ts";
import { ToolPanel, type ToolPanelConfig } from "../../shared/tui/tool-panel.ts";
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
const MAX_PICKER_FILES = 14;

type ReviewMode = { kind: "groups" } | FileMode | MessageMode | NoteMode;

type FileMode =
	| {
			kind: "files";
			purpose: "assign";
			groupId: string;
			list: SelectableList<CommitFileItem>;
			selectedPaths: string[];
	  }
	| {
			kind: "files";
			purpose: "new";
			list: SelectableList<CommitFileItem>;
			selectedPaths: string[];
	  };

type MessageMode =
	| { kind: "message"; purpose: "edit"; groupId: string; editor: Editor }
	| { kind: "message"; purpose: "new"; editor: Editor };

type NoteMode =
	| { kind: "note"; target: "message"; groupId: string; input: Input }
	| { kind: "note"; target: "plan"; input: Input };

interface CommitFileItem extends SelectableListItem {
	path: string;
	status: string;
	ownerId?: string;
	ownerSubject?: string;
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
	return ctx.ui.custom<CommitPlanState | undefined>(
		(tui, theme, _keybindings, done) =>
			new CommitReviewPanel(
				ctx,
				tui,
				theme,
				git,
				root,
				evidence,
				initialPlan,
				initialSelectedGroupId,
				markerType,
				done,
			),
	);
}

class CommitReviewPanel implements Component, Focusable {
	private readonly ctx: ExtensionCommandContext;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly git: GitRunner;
	private readonly root: string;
	private readonly markerType: string;
	private readonly done: (state: CommitPlanState | undefined) => void;
	private readonly panelConfig: ToolPanelConfig;
	private readonly panel: ToolPanel;
	private readonly body: Component;
	private evidence: CommitEvidence;
	private plan: CommitPlanState;
	private selectedGroupId: string | undefined;
	private mode: ReviewMode = { kind: "groups" };
	private groupList: SelectableList<CommitGroup>;
	private pendingDelete: CommitGroup | undefined;
	private busyMessage: string | undefined;
	private _focused = false;

	constructor(
		ctx: ExtensionCommandContext,
		tui: TUI,
		theme: Theme,
		git: GitRunner,
		root: string,
		evidence: CommitEvidence,
		initialPlan: CommitPlanState,
		initialSelectedGroupId: string | undefined,
		markerType: string,
		done: (state: CommitPlanState | undefined) => void,
	) {
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
		this.git = git;
		this.root = root;
		this.evidence = evidence;
		this.plan = initialPlan;
		this.selectedGroupId = initialSelectedGroupId;
		this.markerType = markerType;
		this.done = done;
		this.groupList = this.createGroupList(initialPlan.groups);
		this.groupList.setItems(initialPlan.groups, initialSelectedGroupId);
		this.body = {
			render: (width) => this.renderBody(width),
			invalidate: () => this.activeBody().invalidate(),
		};
		this.panelConfig = {
			title: this.titleText(),
			secondary: this.secondaryText(),
			header: this.headerLines(),
			body: this.body,
			footer: this.footer(),
		};
		this.panel = new ToolPanel(theme, this.panelConfig);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}

	render = (width: number): string[] => {
		return this.panel.render(width);
	};

	invalidate = (): void => {
		this.panel.invalidate();
	};

	handleInput(data: string): void {
		if (this.busyMessage) return;
		if (this.pendingDelete) {
			this.handleDeleteAck(data);
			return;
		}

		if (this.mode.kind === "groups") this.handleGroupsInput(data);
		else if (this.mode.kind === "files") this.handleFilesInput(data, this.mode);
		else if (this.mode.kind === "message") this.handleMessageInput(data, this.mode);
		else this.handleNoteInput(data, this.mode);
	}

	private createGroupList(groups: readonly CommitGroup[]): SelectableList<CommitGroup> {
		return new SelectableList(this.theme, {
			items: groups,
			emptyMessage: "No commit groups. Press n to create one.",
			selection: { kind: "single", primaryLabel: "commit" },
			actions: [
				{ id: "edit", key: "e", hint: rawHint("e", "edit") },
				{ id: "files", key: "f", hint: rawHint("f", "files") },
				{ id: "regenMessage", key: "r", hint: rawHint("r", "regen") },
				{ id: "delete", key: Key.delete, hint: rawHint("delete", "delete") },
				{ id: "new", key: "n", hint: rawHint("n", "new") },
				{ id: "regenPlan", key: Key.shift("r"), hint: rawHint("R", "regen plan") },
			],
			cancelLabel: "cancel",
			maxVisible: MAX_GROUPS,
			renderItem: (group, state, width) => this.renderGroup(group, state.active, width),
			onResult: (result) => this.handleGroupResult(result),
		});
	}

	private handleGroupsInput(data: string): void {
		this.groupList.handleInput(data);
		this.syncSelectedGroupFromCursor();
		this.syncPanel();
	}

	private handleGroupResult(result: SelectableListResult<CommitGroup>): void {
		if (result.kind === "cancel") {
			this.ctx.ui.notify("Commit cancelled.", "info");
			this.done(undefined);
			return;
		}
		if (result.kind === "primary") {
			this.done(this.plan);
			return;
		}

		switch (result.actionId) {
			case "new":
				this.openNewGroupFiles();
				return;
			case "regenPlan":
				this.openPlanRegenerationNote();
				return;
		}

		const item = result.items[0];
		if (!item) return;
		this.selectedGroupId = item.id;
		switch (result.actionId) {
			case "edit":
				this.openEditMessage(item);
				return;
			case "files":
				this.openAssignFiles(item);
				return;
			case "regenMessage":
				this.openMessageRegenerationNote(item);
				return;
			case "delete":
				this.pendingDelete = item;
				this.syncPanel();
				return;
		}
	}

	private handleDeleteAck(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.confirmDeleteGroup();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.pendingDelete = undefined;
			this.syncPanel();
		}
	}

	private handleFilesInput(data: string, mode: FileMode): void {
		if (mode.list.isFilterFocused()) {
			mode.list.handleInput(data);
			this.syncPanel();
			return;
		}

		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.saveFileSelection(mode);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.showGroups(mode.purpose === "assign" ? mode.groupId : this.selectedGroupId);
			return;
		}

		mode.list.handleInput(data);
		this.syncPanel();
	}

	private handleMessageInput(data: string, mode: MessageMode): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.showGroups(mode.purpose === "edit" ? mode.groupId : this.selectedGroupId);
			return;
		}
		mode.editor.handleInput(data);
		this.syncPanel();
	}

	private handleNoteInput(data: string, mode: NoteMode): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.showGroups(mode.target === "message" ? mode.groupId : this.selectedGroupId);
			return;
		}
		mode.input.handleInput(data);
		this.syncPanel();
	}

	private openAssignFiles(group: CommitGroup): void {
		const { list, selectedPaths } = this.createFileList(group.id, group.files);
		this.mode = { kind: "files", purpose: "assign", groupId: group.id, list, selectedPaths };
		this.pendingDelete = undefined;
		this.syncFocus();
		this.syncPanel();
	}

	private openNewGroupFiles(): void {
		const { list, selectedPaths } = this.createFileList(undefined, unassignedFiles(this.plan));
		this.mode = { kind: "files", purpose: "new", list, selectedPaths };
		this.pendingDelete = undefined;
		this.syncFocus();
		this.syncPanel();
	}

	private saveFileSelection(mode: FileMode): void {
		if (mode.purpose === "assign") {
			const group = groupById(this.plan, mode.groupId);
			if (!group) {
				this.showGroups(this.plan.groups[0]?.id);
				return;
			}
			this.plan = assignSelectedFiles(this.plan, group.id, mode.selectedPaths);
			this.showGroups(group.id);
			return;
		}

		if (mode.selectedPaths.length === 0) {
			this.ctx.ui.notify("No files selected.", "info");
			this.showGroups(this.selectedGroupId);
			return;
		}

		this.openNewMessage(mode.selectedPaths);
	}

	private openEditMessage(group: CommitGroup): void {
		const editor = this.createMessageEditor(group.message);
		editor.onSubmit = (value) => this.saveEditedMessage(group.id, value);
		this.mode = { kind: "message", purpose: "edit", groupId: group.id, editor };
		this.pendingDelete = undefined;
		this.syncFocus();
		this.syncPanel();
	}

	private openNewMessage(files: readonly string[]): void {
		const editor = this.createMessageEditor("");
		editor.onSubmit = (value) => void this.saveNewMessage(files, value);
		this.mode = { kind: "message", purpose: "new", editor };
		this.pendingDelete = undefined;
		this.syncFocus();
		this.syncPanel();
	}

	private saveEditedMessage(groupId: string, value: string): void {
		if (!value.trim()) {
			this.showGroups(groupId);
			return;
		}
		try {
			this.plan = setMessage(this.plan, groupId, requireCommitMessage(value));
			this.showGroups(groupId);
		} catch (error) {
			this.showInvalidCommitMessage(value, error);
		}
	}

	private async saveNewMessage(files: readonly string[], value: string): Promise<void> {
		const trimmed = value.trim();
		if (trimmed) {
			try {
				const group = { id: randomUUID(), message: requireCommitMessage(trimmed), files: [...files] };
				this.plan = addGroup(this.plan, group);
				this.showGroups(group.id);
			} catch (error) {
				this.showInvalidCommitMessage(value, error);
			}
			return;
		}

		await this.runBusy("Generating commit message", async () => {
			const message = await regenerateMessage(this.ctx, this.evidence, files, this.plan.groups);
			const group = { id: randomUUID(), message, files: [...files] };
			this.plan = addGroup(this.plan, group);
			this.showGroups(group.id);
		});
	}

	private openMessageRegenerationNote(group: CommitGroup): void {
		const input = this.createNoteInput((note) => void this.regenerateSelectedMessage(group.id, note));
		this.mode = { kind: "note", target: "message", groupId: group.id, input };
		this.pendingDelete = undefined;
		this.syncFocus();
		this.syncPanel();
	}

	private openPlanRegenerationNote(): void {
		const input = this.createNoteInput((note) => void this.regenerateWholePlan(note));
		this.mode = { kind: "note", target: "plan", input };
		this.pendingDelete = undefined;
		this.syncFocus();
		this.syncPanel();
	}

	private async regenerateSelectedMessage(groupId: string, note: string): Promise<void> {
		const group = groupById(this.plan, groupId);
		if (!group) {
			this.showGroups(this.plan.groups[0]?.id);
			return;
		}

		await this.runBusy(`Regenerating ${subjectLine(group.message)}`, async () => {
			const message = await regenerateMessage(
				this.ctx,
				this.evidence,
				group.files,
				this.plan.groups,
				group.id,
				note,
			);
			this.plan = setMessage(this.plan, group.id, message);
			this.showGroups(group.id);
		});
	}

	private async regenerateWholePlan(note: string): Promise<void> {
		await this.runBusy("Regenerating commit plan", async () => {
			const evidence = await loadChangeSet(
				this.git,
				this.root,
				this.ctx.sessionManager.getBranch(),
				this.markerType,
			);
			assertCommittableState(evidence.files);
			const plan = {
				files: evidence.files,
				worktreeSignature: await computeWorktreeSignature(this.git, this.root, evidence.files),
				groups: await generatePlan(this.ctx, evidence, this.plan.groups, note),
			};
			this.evidence = evidence;
			this.plan = plan;
			this.showGroups(plan.groups[0]?.id);
		});
	}

	private createFileList(
		targetGroupId: string | undefined,
		initialFiles: readonly string[],
	): { list: SelectableList<CommitFileItem>; selectedPaths: string[] } {
		const ownerByPath = new Map(
			this.plan.groups.flatMap((group) => group.files.map((file) => [file, group] as const)),
		);
		const initial = new Set(initialFiles);
		const items = orderPickerFiles(this.plan, targetGroupId, initialFiles).map((file) =>
			toCommitFileItem(file, ownerByPath.get(file.path)),
		);
		const selectedPaths = items.filter((item) => initial.has(item.path)).map((item) => item.path);
		const list = new SelectableList(this.theme, {
			items,
			emptyMessage: "No dirty files.",
			selection: { kind: "multi" },
			filter: { searchText: (item) => `${item.path} ${item.status} ${item.ownerSubject ?? "unassigned"}` },
			actions: [],
			maxVisible: MAX_PICKER_FILES,
			renderItem: (item, state, width) => this.renderFile(item, targetGroupId, state.active, width),
			onResult: () => {},
			onSelectionChange: (selected) => {
				const mode = this.mode;
				if (mode.kind !== "files") return;
				mode.selectedPaths = selected.map((item) => item.path);
				this.syncPanel();
			},
		});
		list.setSelectedIds(initialFiles);
		return { list, selectedPaths };
	}

	private createMessageEditor(value: string): Editor {
		const editor = new Editor(this.tui, editorTheme(this.theme));
		editor.setText(value);
		editor.focused = this._focused;
		return editor;
	}

	private showInvalidCommitMessage(value: string, error: unknown): void {
		const mode = this.mode;
		if (mode.kind === "message") mode.editor.setText(value);
		this.ctx.ui.notify(`Invalid commit message: ${errorText(error)}`, "error");
		this.syncPanel();
	}

	private createNoteInput(onSubmit: (value: string) => void): Input {
		const input = new Input();
		input.focused = this._focused;
		input.onSubmit = onSubmit;
		input.onEscape = () => this.showGroups(this.selectedGroupId);
		return input;
	}

	private confirmDeleteGroup(): void {
		const pending = this.pendingDelete;
		if (!pending) return;
		const oldIndex = this.plan.groups.findIndex((group) => group.id === pending.id);
		const groups = this.plan.groups.filter((group) => group.id !== pending.id);
		this.plan = { ...this.plan, groups };
		this.pendingDelete = undefined;
		this.showGroups(groups[Math.min(oldIndex, Math.max(0, groups.length - 1))]?.id);
	}

	private async runBusy(message: string, task: () => Promise<void>): Promise<void> {
		if (this.busyMessage) return;
		this.busyMessage = message;
		this.syncPanel();
		try {
			await task();
		} catch (error) {
			this.ctx.ui.notify(`${message} failed: ${errorText(error)}`, "error");
		} finally {
			this.busyMessage = undefined;
			this.syncPanel();
		}
	}

	private showGroups(activeId: string | undefined): void {
		this.mode = { kind: "groups" };
		this.pendingDelete = undefined;
		this.selectedGroupId = this.plan.groups.some((group) => group.id === activeId)
			? activeId
			: (this.plan.groups[0]?.id ?? undefined);
		this.groupList.setItems(this.plan.groups, this.selectedGroupId);
		this.syncFocus();
		this.syncPanel();
	}

	private syncSelectedGroupFromCursor(): void {
		this.selectedGroupId = this.groupList.getCurrentItem()?.id;
	}

	private syncPanel(): void {
		this.panelConfig.title = this.titleText();
		this.panelConfig.secondary = this.secondaryText();
		this.panelConfig.header = this.headerLines();
		this.panelConfig.footer = this.footer();
		this.tui.requestRender();
	}

	private syncFocus(): void {
		this.groupList.focused = this._focused && this.mode.kind === "groups";
		if (this.mode.kind === "files") this.mode.list.focused = this._focused;
		if (this.mode.kind === "message") this.mode.editor.focused = this._focused;
		if (this.mode.kind === "note") this.mode.input.focused = this._focused;
	}

	private activeBody(): Component {
		if (this.mode.kind === "files") return this.mode.list;
		if (this.mode.kind === "message") return this.mode.editor;
		if (this.mode.kind === "note") return this.mode.input;
		return this.groupList;
	}

	private renderBody(width: number): string[] {
		if (this.mode.kind === "message") return this.renderMessageEditor(this.mode, width);
		if (this.mode.kind === "note") return this.renderNoteInput(this.mode, width);
		return this.activeBody().render(width);
	}

	private renderMessageEditor(mode: MessageMode, width: number): string[] {
		const renderWidth = Math.max(1, width);
		const label = mode.purpose === "new" ? "Commit message (empty = auto-generate)" : "Commit message";
		return [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(label)), renderWidth, ""),
			...mode.editor.render(renderWidth),
		];
	}

	private renderNoteInput(mode: NoteMode, width: number): string[] {
		const renderWidth = Math.max(1, width);
		const label = mode.target === "plan" ? "Regeneration note for plan" : "Regeneration note for message";
		return [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(`${label} (optional)`)), renderWidth, ""),
			...mode.input.render(renderWidth),
		];
	}

	private renderGroup(group: CommitGroup, active: boolean, width: number): string[] {
		const subject = subjectLine(group.message);
		const count = `${group.files.length} file${group.files.length === 1 ? "" : "s"}`;
		const suffix = this.theme.fg(group.files.length === 0 ? "warning" : "dim", `  ${count}`);
		const titleWidth = Math.max(8, width - visibleWidth(count) - 2);
		const title = this.theme.fg(active ? "accent" : "text", truncateToWidth(subject, titleWidth, ""));
		return [truncateToWidth(`${title}${suffix}`, width, "")];
	}

	private renderFile(
		item: CommitFileItem,
		targetGroupId: string | undefined,
		active: boolean,
		width: number,
	): string[] {
		const owner = item.ownerId
			? item.ownerId === targetGroupId
				? "current"
				: `currently: ${item.ownerSubject ?? item.ownerId}`
			: "";
		const hint = owner ? this.theme.fg(item.ownerId === targetGroupId ? "success" : "muted", `  ${owner}`) : "";
		const pathWidth = Math.max(8, width - visibleWidth(item.status) - visibleWidth(owner) - 4);
		const path = this.theme.fg(active ? "accent" : "text", truncateToWidth(item.path, pathWidth, ""));
		return [truncateToWidth(`${this.theme.fg("muted", item.status)} ${path}${hint}`, width, "")];
	}

	private titleText(): string {
		if (this.mode.kind === "files") return this.mode.purpose === "new" ? "New commit files" : "Assign files";
		if (this.mode.kind === "message") return this.mode.purpose === "new" ? "New commit" : "Edit commit";
		if (this.mode.kind === "note") return "Regenerate";
		return "Commit plan";
	}

	private secondaryText(): string {
		if (this.mode.kind === "files") {
			return `${this.mode.selectedPaths.length} selected · ${this.plan.files.length} files`;
		}
		const groupCount = this.plan.groups.length;
		return `${groupCount} commit${groupCount === 1 ? "" : "s"} · ${this.plan.files.length} files`;
	}

	private headerLines(): readonly string[] {
		const lines: string[] = [];
		if (this.busyMessage) lines.push(this.theme.fg("muted", this.busyMessage));
		if (this.mode.kind === "groups") {
			const count = unassignedFiles(this.plan).length;
			if (count > 0) lines.push(this.theme.fg("warning", `${count} unassigned file(s)`));
		}
		return lines;
	}

	private footer(): ToolPanelConfig["footer"] {
		if (this.pendingDelete) {
			return {
				kind: "destructiveAck",
				message: `Remove commit group: ${subjectLine(this.pendingDelete.message)}?`,
				hints: [bindingHint("tui.select.confirm", "confirm"), bindingHint("tui.select.cancel", "cancel")],
			};
		}
		return { kind: "hints", hints: this.footerHints() };
	}

	private footerHints(): readonly ToolKeyHint[] {
		if (this.busyMessage) return [];
		if (this.mode.kind === "files") {
			if (this.mode.list.isFilterFocused()) return this.mode.list.getKeyHints();
			return [
				...this.mode.list.getKeyHints(),
				bindingHint("tui.select.confirm", "save"),
				bindingHint("tui.select.cancel", "cancel"),
			];
		}
		if (this.mode.kind === "message") {
			return [
				bindingHint("tui.input.submit", this.mode.purpose === "new" ? "save/auto" : "save"),
				bindingHint("tui.input.newLine", "newline"),
				bindingHint("tui.select.cancel", "cancel"),
			];
		}
		if (this.mode.kind === "note") {
			return [bindingHint("tui.input.submit", "generate"), bindingHint("tui.select.cancel", "cancel")];
		}

		return this.groupList.getKeyHints();
	}
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

function groupById(plan: CommitPlanState, groupId: string): CommitGroup | undefined {
	return plan.groups.find((item) => item.id === groupId);
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

function toCommitFileItem(file: DirtyFile, owner: CommitGroup | undefined): CommitFileItem {
	return {
		id: file.path,
		path: file.path,
		status: file.status,
		...(owner ? { ownerId: owner.id, ownerSubject: subjectLine(owner.message) } : {}),
	};
}

function subjectLine(message: string): string {
	return message.split("\n")[0] ?? message;
}
