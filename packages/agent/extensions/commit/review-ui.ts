import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	CancellableLoader,
	type Component,
	Editor,
	type Focusable,
	getKeybindings,
	Input,
	Key,
	Loader,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { emitAgentBlocked } from "../../shared/agent-blocked.ts";
import type { GitRunner } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";
import { bindingHint, editorTheme, rawHint, type ToolKeyHint } from "@shanepadgett/tau-tui";
import { SelectableList, type SelectableListResult } from "@shanepadgett/tau-tui";
import { ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";
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
	commitStaged,
	computeWorktreeSignature,
	type DirtyFile,
	loadChangeSet,
	stageFilesOnly,
} from "./git-change-set.ts";

const MAX_GROUPS = 10;
const PUSH_TIMEOUT_MS = 120_000;

export interface CommitMarker {
	hash: string;
	subject: string;
	timestamp: number;
}

type ReviewMode = { kind: "groups" } | MessageMode | NoteMode;

type MessageMode = { kind: "message"; groupId: string; editor: Editor };

type NoteMode =
	| { kind: "note"; target: "message"; groupId: string; input: Input }
	| { kind: "note"; target: "plan"; input: Input };

type FlowPhase =
	| { kind: "working"; cancellable: boolean }
	| { kind: "review"; mode: ReviewMode }
	| {
			kind: "committing";
			groups: readonly CommitGroup[];
			rows: CommitProgressRow[];
			detail: string;
	  }
	| {
			kind: "failed";
			message: string;
			completed: readonly CommitMarker[];
			rows: readonly CommitProgressRow[];
	  };

interface CommitProgressRow {
	subject: string;
	state: "pending" | "active" | "done" | "error";
	hash?: string;
}

export async function runCommitFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitRunner,
	root: string,
	markerType: string,
	options?: { push?: boolean },
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new CommitFlowPanel(pi, ctx, tui, theme, git, root, markerType, options?.push ?? false, done),
	);
}

export async function pushCurrentBranch(git: GitRunner, root: string): Promise<void> {
	const branchRef = await git.run(["symbolic-ref", "--quiet", "HEAD"], { cwd: root });
	const upstream = await git.run(["for-each-ref", "--format=%(upstream)", branchRef], {
		cwd: root,
	});
	const args = upstream ? ["push"] : ["push", "--set-upstream", "origin", branchRef];
	await git.run(args, { cwd: root, timeout: PUSH_TIMEOUT_MS });
}

export class PartialCommitError extends Error {
	readonly completed: readonly CommitMarker[];

	constructor(message: string, completed: readonly CommitMarker[]) {
		super(message);
		this.name = "PartialCommitError";
		this.completed = completed;
	}
}

export async function executeCommitPlan(
	pi: ExtensionAPI,
	git: GitRunner,
	root: string,
	state: CommitPlanState,
	markerType: string,
	onProgress?: (update: {
		index: number;
		total: number;
		subject: string;
		phase: "start" | "done";
		hash?: string;
	}) => void,
): Promise<CommitMarker[]> {
	const groups = state.groups.filter((group) => group.files.length > 0);
	if (groups.length === 0) return [];

	if ((await computeWorktreeSignature(git, root, state.files)) !== state.worktreeSignature) {
		throw new Error("Working tree changed during commit review. Regenerate the commit plan and try again.");
	}

	const filesByPath = new Map(state.files.map((file) => [file.path, file]));
	const completed: CommitMarker[] = [];
	try {
		for (const [index, group] of groups.entries()) {
			const subject = subjectLine(group.message);
			onProgress?.({ index, total: groups.length, subject, phase: "start" });
			await stageFilesOnly(
				git,
				root,
				group.files.flatMap((path) => knownFile(filesByPath, path)),
			);
			const hash = await commitStaged(git, root, group.message);
			const marker = { hash, subject, timestamp: Date.now() };
			completed.push(marker);
			pi.appendEntry<CommitMarker>(markerType, marker);
			onProgress?.({ index, total: groups.length, subject, phase: "done", hash });
		}
	} catch (error) {
		if (completed.length > 0) throw new PartialCommitError(errorText(error), completed);
		throw error;
	}
	return completed;
}

class CommitFlowPanel implements Component, Focusable {
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionCommandContext;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly git: GitRunner;
	private readonly root: string;
	private readonly markerType: string;
	private readonly autoPush: boolean;
	private readonly done: () => void;
	private readonly panelConfig: ToolPanelConfig;
	private readonly panel: ToolPanel;
	private readonly body: Component;
	private evidence: CommitEvidence | undefined;
	private plan: CommitPlanState | undefined;
	private selectedGroupId: string | undefined;
	private phase: FlowPhase = { kind: "working", cancellable: true };
	private groupList: SelectableList<CommitGroup>;
	private working: Loader | CancellableLoader | undefined;
	private closed = false;
	private _focused = false;

	constructor(
		pi: ExtensionAPI,
		ctx: ExtensionCommandContext,
		tui: TUI,
		theme: Theme,
		git: GitRunner,
		root: string,
		markerType: string,
		autoPush: boolean,
		done: () => void,
	) {
		this.pi = pi;
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
		this.git = git;
		this.root = root;
		this.markerType = markerType;
		this.autoPush = autoPush;
		this.done = done;
		this.groupList = this.createGroupList([]);
		this.body = {
			render: (width) => this.renderBody(width),
			invalidate: () => this.activeBody()?.invalidate(),
		};
		this.panelConfig = {
			title: this.titleText(),
			header: this.headerLines(),
			body: this.body,
			footer: this.footer(),
		};
		this.panel = new ToolPanel(theme, this.panelConfig);
		void this.bootstrap();
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
		if (this.closed) return;

		if (this.working instanceof CancellableLoader) {
			this.working.handleInput(data);
			return;
		}
		if (this.working || this.phase.kind === "working") return;
		if (this.phase.kind === "committing") return;
		if (this.phase.kind === "failed") {
			if (
				getKeybindings().matches(data, "tui.select.confirm") ||
				getKeybindings().matches(data, "tui.select.cancel")
			) {
				this.close();
			}
			return;
		}

		const mode = this.phase.mode;
		if (mode.kind === "groups") this.handleGroupsInput(data);
		else if (mode.kind === "message") this.handleMessageInput(data, mode);
		else this.handleNoteInput(data, mode);
	}

	private async bootstrap(): Promise<void> {
		try {
			this.startWorking("Gathering changes", true);
			const evidence = await loadChangeSet(
				this.git,
				this.root,
				this.ctx.sessionManager.getBranch(),
				this.markerType,
			);
			if (this.isCancelled()) return this.cancelFlow();
			assertCommittableState(evidence.files);
			this.evidence = evidence;

			this.startWorking("Generating plan", true);
			const groups = await generatePlan(this.generationCtx(), evidence, [], "", {
				onStatus: (status) => this.setWorkingMessage(status),
			});
			if (this.isCancelled()) return this.cancelFlow();

			this.plan = {
				files: evidence.files,
				worktreeSignature: await computeWorktreeSignature(this.git, this.root, evidence.files),
				groups,
			};
			if (this.isCancelled()) return this.cancelFlow();
			this.stopWorking();
			emitAgentBlocked(this.pi, { body: "Waiting for commit plan review", source: "commit.review" });
			this.showGroups(groups[0]?.id);
		} catch (error) {
			if (this.isCancelled() || this.closed) return this.cancelFlow();
			this.stopWorking();
			this.ctx.ui.notify(`Commit failed: ${errorText(error)}`, "error");
			this.close();
		}
	}

	private generationCtx(): ExtensionCommandContext {
		const signal = this.working instanceof CancellableLoader ? this.working.signal : this.ctx.signal;
		return { ...this.ctx, signal };
	}

	private isCancelled(): boolean {
		return this.working instanceof CancellableLoader && this.working.aborted;
	}

	private startWorking(message: string, cancellable: boolean): void {
		this.stopWorking();
		const accent = (text: string) => this.theme.fg("accent", text);
		const muted = (text: string) => this.theme.fg("muted", text);
		if (cancellable) {
			const loader = new CancellableLoader(this.tui, accent, muted, message);
			loader.onAbort = () => this.cancelFlow();
			this.working = loader;
		} else {
			this.working = new Loader(this.tui, accent, muted, message);
		}
		this.phase = { kind: "working", cancellable };
		this.syncFocus();
		this.syncPanel();
	}

	private setWorkingMessage(message: string): void {
		this.working?.setMessage(message);
		this.tui.requestRender();
	}

	private stopWorking(): void {
		if (!this.working) return;
		if (this.working instanceof CancellableLoader) this.working.dispose();
		else this.working.stop();
		this.working = undefined;
	}

	private createGroupList(groups: readonly CommitGroup[]): SelectableList<CommitGroup> {
		return new SelectableList(this.theme, {
			items: groups,
			emptyMessage: "No commit groups.",
			selection: { kind: "single", primaryLabel: "commit" },
			actions: [
				{ id: "edit", key: "e", hint: rawHint("e", "edit") },
				{ id: "regenMessage", key: "r", hint: rawHint("r", "regen") },
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
			this.close();
			return;
		}
		if (result.kind === "primary") {
			void this.beginCommitting();
			return;
		}

		if (result.actionId === "regenPlan") {
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
			case "regenMessage":
				this.openMessageRegenerationNote(item);
				return;
		}
	}

	private handleMessageInput(data: string, mode: MessageMode): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.showGroups(mode.groupId);
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

	private openEditMessage(group: CommitGroup): void {
		const editor = this.createMessageEditor(group.message);
		editor.onSubmit = (value) => this.saveEditedMessage(group.id, value);
		this.setReviewMode({ kind: "message", groupId: group.id, editor });
	}

	private saveEditedMessage(groupId: string, value: string): void {
		if (!value.trim()) {
			this.showGroups(groupId);
			return;
		}
		try {
			this.plan = setMessage(this.requirePlan(), groupId, requireCommitMessage(value));
			this.showGroups(groupId);
		} catch (error) {
			this.showInvalidCommitMessage(value, error);
		}
	}

	private openMessageRegenerationNote(group: CommitGroup): void {
		const input = this.createNoteInput((note) => void this.regenerateSelectedMessage(group.id, note));
		this.setReviewMode({ kind: "note", target: "message", groupId: group.id, input });
	}

	private openPlanRegenerationNote(): void {
		const input = this.createNoteInput((note) => void this.regenerateWholePlan(note));
		this.setReviewMode({ kind: "note", target: "plan", input });
	}

	private async regenerateSelectedMessage(groupId: string, note: string): Promise<void> {
		const plan = this.requirePlan();
		const evidence = this.requireEvidence();
		const group = groupById(plan, groupId);
		if (!group) {
			this.showGroups(plan.groups[0]?.id);
			return;
		}

		await this.runBusy(`Regenerating ${subjectLine(group.message)}`, async () => {
			const message = await regenerateMessage(
				this.generationCtx(),
				evidence,
				group.files,
				plan.groups,
				group.id,
				note,
				{ onStatus: (status) => this.setWorkingMessage(status) },
			);
			this.plan = setMessage(this.requirePlan(), group.id, message);
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
				groups: await generatePlan(this.generationCtx(), evidence, this.requirePlan().groups, note, {
					onStatus: (status) => this.setWorkingMessage(status),
				}),
			};
			this.evidence = evidence;
			this.plan = plan;
			this.showGroups(plan.groups[0]?.id);
		});
	}

	private async beginCommitting(): Promise<void> {
		const plan = this.requirePlan();
		const groups = plan.groups.filter((group) => group.files.length > 0);
		if (groups.length === 0) {
			this.ctx.ui.notify("No commit groups to execute.", "info");
			return;
		}

		const rows: CommitProgressRow[] = groups.map((group) => ({
			subject: subjectLine(group.message),
			state: "pending",
		}));
		this.stopWorking();
		this.setPhase({
			kind: "committing",
			groups,
			rows,
			detail: "Checking worktree…",
		});

		try {
			const landed = await executeCommitPlan(this.pi, this.git, this.root, plan, this.markerType, (update) => {
				if (this.phase.kind !== "committing") return;
				const rowsNext = this.phase.rows.map((row, index) => {
					if (index !== update.index) return row;
					if (update.phase === "start") return { subject: update.subject, state: "active" as const };
					return { subject: update.subject, state: "done" as const, hash: update.hash };
				});
				this.setPhase({
					kind: "committing",
					groups: this.phase.groups,
					rows: rowsNext,
					detail:
						update.phase === "start"
							? "Running git commit (hooks included)…"
							: `Committed ${update.hash ?? ""}`.trim(),
				});
			});
			if (!this.autoPush) {
				this.ctx.ui.notify(
					`Committed ${landed.length} commit(s): ${landed.map((item) => item.hash).join(", ")}`,
					"info",
				);
				this.close();
				return;
			}
			this.startWorking("Pushing", false);
			try {
				await pushCurrentBranch(this.git, this.root);
				this.stopWorking();
				this.ctx.ui.notify(
					`Committed and pushed ${landed.length} commit(s): ${landed.map((item) => item.hash).join(", ")}`,
					"info",
				);
			} catch (error) {
				this.stopWorking();
				this.ctx.ui.notify(
					`Committed ${landed.length} commit(s): ${landed.map((item) => item.hash).join(", ")}; push failed: ${errorText(error)}`,
					"error",
				);
			}
			this.close();
		} catch (error) {
			const partial = error instanceof PartialCommitError ? error.completed : [];
			const message = error instanceof PartialCommitError ? error.message : errorText(error);
			if (partial.length > 0) {
				this.ctx.ui.notify(
					`Partially committed ${partial.length}: ${partial.map((item) => item.hash).join(", ")}; then failed: ${message}`,
					"warning",
				);
			} else {
				this.ctx.ui.notify(`Commit failed: ${message}`, "error");
			}
			const rowsNext =
				this.phase.kind === "committing"
					? this.phase.rows.map((row) => (row.state === "active" ? { ...row, state: "error" as const } : row))
					: rows;
			this.setPhase({ kind: "failed", message, completed: partial, rows: rowsNext });
		}
	}

	private createMessageEditor(value: string): Editor {
		const editor = new Editor(this.tui, editorTheme(this.theme));
		editor.setText(value);
		editor.focused = this._focused;
		return editor;
	}

	private showInvalidCommitMessage(value: string, error: unknown): void {
		if (this.phase.kind === "review" && this.phase.mode.kind === "message") {
			this.phase.mode.editor.setText(value);
		}
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

	private async runBusy(message: string, task: () => Promise<void>): Promise<void> {
		if (this.working) return;
		const previous = this.phase;
		this.startWorking(message, false);
		try {
			await task();
		} catch (error) {
			this.ctx.ui.notify(`${message} failed: ${errorText(error)}`, "error");
			this.stopWorking();
			if (previous.kind === "review") this.setPhase(previous);
			else this.syncPanel();
			return;
		}
		this.stopWorking();
	}

	private showGroups(activeId: string | undefined): void {
		const plan = this.requirePlan();
		this.stopWorking();
		this.selectedGroupId = plan.groups.some((group) => group.id === activeId)
			? activeId
			: (plan.groups[0]?.id ?? undefined);
		this.groupList.setItems(plan.groups, this.selectedGroupId);
		this.setPhase({ kind: "review", mode: { kind: "groups" } });
	}

	private setReviewMode(mode: ReviewMode): void {
		this.stopWorking();
		this.setPhase({ kind: "review", mode });
	}

	private setPhase(phase: FlowPhase): void {
		this.phase = phase;
		this.syncFocus();
		this.syncPanel();
	}

	private syncSelectedGroupFromCursor(): void {
		this.selectedGroupId = this.groupList.getCurrentItem()?.id;
	}

	private syncPanel(): void {
		this.panelConfig.title = this.titleText();
		this.panelConfig.header = this.headerLines();
		this.panelConfig.footer = this.footer();
		this.tui.requestRender();
	}

	private syncFocus(): void {
		const review = this.phase.kind === "review" && !this.working ? this.phase.mode : undefined;
		this.groupList.focused = this._focused && review?.kind === "groups";
		if (review?.kind === "message") review.editor.focused = this._focused;
		if (review?.kind === "note") review.input.focused = this._focused;
	}

	private activeBody(): Component | undefined {
		if (this.working) return this.working;
		if (this.phase.kind !== "review") return undefined;
		if (this.phase.mode.kind === "message") return this.phase.mode.editor;
		if (this.phase.mode.kind === "note") return this.phase.mode.input;
		return this.groupList;
	}

	private renderBody(width: number): string[] {
		if (this.working) {
			// Pi's Loader prepends a blank line; the panel already separates title from body.
			const lines = this.working.render(width);
			return lines[0] === "" ? lines.slice(1) : lines;
		}
		if (this.phase.kind === "working") return [];
		if (this.phase.kind === "committing") {
			return this.renderProgressBody(width, this.phase.rows, this.phase.detail);
		}
		if (this.phase.kind === "failed") {
			const lines = this.renderProgressBody(width, this.phase.rows, "");
			const errorLines = wrapTextWithAnsi(this.theme.fg("error", this.phase.message), width).map((line) =>
				truncateToWidth(line, width, ""),
			);
			return lines.length > 0 ? [...lines, "", ...errorLines] : errorLines;
		}
		if (this.phase.mode.kind === "message") return this.renderMessageEditor(this.phase.mode, width);
		if (this.phase.mode.kind === "note") return this.renderNoteInput(this.phase.mode, width);
		return this.activeBody()?.render(width) ?? [];
	}

	private renderProgressBody(width: number, rows: readonly CommitProgressRow[], detail: string): string[] {
		const lines = rows.map((row) => {
			const mark =
				row.state === "done"
					? this.theme.fg("success", "✓")
					: row.state === "error"
						? this.theme.fg("error", "✗")
						: row.state === "active"
							? this.theme.fg("accent", "●")
							: this.theme.fg("dim", "○");
			const subject = this.theme.fg(row.state === "active" ? "accent" : "text", row.subject);
			const suffix = row.hash
				? this.theme.fg("dim", `  ${row.hash}`)
				: row.state === "active"
					? this.theme.fg("muted", "  running…")
					: "";
			return truncateToWidth(`${mark} ${subject}${suffix}`, width, "");
		});
		if (!detail) return lines;
		return [...lines, "", truncateToWidth(this.theme.fg("muted", detail), width, "")];
	}

	private renderMessageEditor(mode: MessageMode, width: number): string[] {
		const renderWidth = Math.max(1, width);
		const label = "Commit message";
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

	private titleText(): string {
		if (this.working || this.phase.kind === "working") return "Commit";
		if (this.phase.kind === "committing") return "Committing";
		if (this.phase.kind === "failed") return "Commit failed";
		if (this.phase.mode.kind === "message") return "Edit commit";
		if (this.phase.mode.kind === "note") return "Regenerate";
		return "Commit plan";
	}

	private headerLines(): readonly string[] {
		return [];
	}

	private footer(): ToolPanelConfig["footer"] {
		return { kind: "hints", hints: this.footerHints() };
	}

	private footerHints(): readonly ToolKeyHint[] {
		if (this.working instanceof CancellableLoader || (this.phase.kind === "working" && this.phase.cancellable)) {
			return [bindingHint("tui.select.cancel", "cancel")];
		}
		if (this.working || this.phase.kind === "working" || this.phase.kind === "committing") return [];
		if (this.phase.kind === "failed") {
			return [bindingHint("tui.select.confirm", "dismiss")];
		}
		if (this.phase.mode.kind === "message") {
			return [
				bindingHint("tui.input.submit", "save"),
				bindingHint("tui.input.newLine", "newline"),
				bindingHint("tui.select.cancel", "cancel"),
			];
		}
		if (this.phase.mode.kind === "note") {
			return [bindingHint("tui.input.submit", "generate"), bindingHint("tui.select.cancel", "cancel")];
		}
		return this.groupList.getKeyHints();
	}

	private requirePlan(): CommitPlanState {
		if (!this.plan) throw new Error("Commit plan is not ready.");
		return this.plan;
	}

	private requireEvidence(): CommitEvidence {
		if (!this.evidence) throw new Error("Commit evidence is not ready.");
		return this.evidence;
	}

	private cancelFlow(): void {
		if (this.closed) return;
		this.ctx.ui.notify("Commit cancelled.", "info");
		this.close();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopWorking();
		this.done();
	}
}

function setMessage(plan: CommitPlanState, groupId: string, message: string): CommitPlanState {
	return { ...plan, groups: plan.groups.map((group) => (group.id === groupId ? { ...group, message } : group)) };
}

function groupById(plan: CommitPlanState, groupId: string): CommitGroup | undefined {
	return plan.groups.find((item) => item.id === groupId);
}

function subjectLine(message: string): string {
	return message.split("\n")[0] ?? message;
}

function knownFile(filesByPath: ReadonlyMap<string, DirtyFile>, path: string): DirtyFile[] {
	const file = filesByPath.get(path);
	return file ? [file] : [];
}
