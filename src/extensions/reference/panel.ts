import { spawn } from "node:child_process";
import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { GitRunner } from "../../shared/git.ts";
import { formatAge } from "../../shared/text.ts";
import { bindingHint, rawHint } from "../../shared/tui/key-hints.ts";
import {
	type MultiSelectActionResult,
	MultiSelectList,
	type MultiSelectListItem,
} from "../../shared/tui/multi-select-list.ts";
import { ToolPanel, type ToolPanelConfig } from "../../shared/tui/tool-panel.ts";
import { visibleWindow } from "../../shared/tui/viewport.ts";
import type { ReferenceEditor } from "./settings.ts";

const REFERENCES_DIR = join(homedir(), ".local", "share", "tau-agent", "references");
const UPDATE_TIMEOUT_MS = 120_000;
const BRANCH_LOOKUP_TIMEOUT_MS = 15_000;
const BRANCH_SWITCH_TIMEOUT_MS = 120_000;
const CLONE_STALL_MS = 180_000;
const REFERENCE_VISIBLE_ROWS = 10;
const BRANCH_VISIBLE_ROWS = 5;

export interface ReferenceItem {
	name: string;
	path: string;
	dirty: boolean;
	branch: string;
}

interface ReferenceListItem extends ReferenceItem, MultiSelectListItem {
	state?: "updating" | "updated" | "failed" | "switching";
}

interface CloneProgress {
	phase: "receiving" | "resolving" | "updating";
	percent: number;
}

interface CloneStatus {
	name: string;
	path: string;
	progress?: CloneProgress;
}

interface ReferenceBranch {
	name: string;
	updatedAt?: number;
	isCurrent: boolean;
}

interface BranchPicker {
	item: ReferenceListItem;
	branches: ReferenceBranch[];
	cursor: number;
}

interface DeleteConfirm {
	items: readonly ReferenceListItem[];
	label: string;
}

export async function showReferencePanel(
	git: GitRunner,
	ctx: ExtensionCommandContext,
	editor: ReferenceEditor,
	branchChoices: number,
): Promise<ReferenceItem[] | undefined> {
	let initial: ReferenceItem[];
	try {
		initial = await loadReferences(git);
	} catch (error) {
		ctx.ui.notify(`Reference load failed: ${errorText(error)}`, "error");
		initial = [];
	}

	return ctx.ui.custom<ReferenceItem[] | undefined>(
		(tui, theme, _keybindings, done) =>
			new ReferencePanel(tui, theme, git, ctx, editor, branchChoices, initial, done),
	);
}

export async function cloneFromCommand(ctx: ExtensionCommandContext, url: string): Promise<void> {
	let name: string;
	try {
		name = referenceNameFromUrl(url);
	} catch (error) {
		ctx.ui.notify(errorText(error), "error");
		return;
	}

	const path = join(REFERENCES_DIR, name);
	ctx.ui.setStatus("reference", `cloning ${name}`);
	try {
		await cloneReference(url, name, path, ctx.signal, () => {});
		ctx.ui.notify(`Added ${name} to ${path}`, "info");
	} catch (error) {
		ctx.ui.notify(`New reference failed: ${errorText(error)}`, "error");
	} finally {
		ctx.ui.setStatus("reference", undefined);
	}
}

class ReferencePanel implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly git: GitRunner;
	private readonly ctx: ExtensionCommandContext;
	private readonly editor: ReferenceEditor;
	private readonly branchChoices: number;
	private readonly done: (result: ReferenceItem[] | undefined) => void;
	private readonly panelConfig: ToolPanelConfig;
	private readonly panel: ToolPanel;
	private readonly body: Component;
	private readonly branchCache = new Map<string, ReferenceBranch[]>();
	private refs: ReferenceListItem[];
	private selected: readonly ReferenceListItem[] = [];
	private list: MultiSelectList<ReferenceListItem>;
	private deleteConfirm: DeleteConfirm | undefined;
	private cloneInput: Input | undefined;
	private cloneStatus: CloneStatus | undefined;
	private branchPicker: BranchPicker | undefined;
	private updating = false;

	constructor(
		tui: TUI,
		theme: Theme,
		git: GitRunner,
		ctx: ExtensionCommandContext,
		editor: ReferenceEditor,
		branchChoices: number,
		initial: readonly ReferenceItem[],
		done: (result: ReferenceItem[] | undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.git = git;
		this.ctx = ctx;
		this.editor = editor;
		this.branchChoices = branchChoices;
		this.done = done;
		this.refs = initial.map((item) => toListItem(item));
		this.list = this.createList(this.refs);
		this.body = {
			render: (width) => this.renderBody(width),
			invalidate: () => this.list.invalidate(),
		};
		this.panelConfig = {
			title: "References",
			secondary: this.secondaryText(),
			header: this.headerLines(),
			body: this.body,
			footer: { kind: "hints", hints: this.footerHints() },
		};
		this.panel = new ToolPanel(theme, this.panelConfig);
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	handleInput(data: string): void {
		if (this.branchPicker) {
			this.handleBranchInput(data);
			return;
		}
		if (this.cloneInput) {
			this.cloneInput.handleInput(data);
			this.syncPanel();
			return;
		}
		if (this.deleteConfirm) {
			this.handleDeleteConfirmInput(data);
			return;
		}
		if (this.list.isFiltering()) {
			this.list.handleInput(data);
			this.syncPanel();
			return;
		}

		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			if (this.selected.length > 0) this.done(this.selected.map(toReferenceItem));
			return;
		}
		if (data === "n" || data === "N") {
			this.startCloneInput();
			return;
		}
		if (matchesKey(data, Key.delete)) {
			this.startDeleteReferences(
				this.selected.length > 0 ? this.selected : compactCurrent(this.list.getCurrentItem()),
			);
			return;
		}

		this.list.handleInput(/^[A-Z]$/.test(data) ? data.toLowerCase() : data);
		this.syncPanel();
	}

	private createList(items: readonly ReferenceListItem[]): MultiSelectList<ReferenceListItem> {
		return new MultiSelectList(this.theme, {
			items,
			emptyMessage: "No references. Press n for new.",
			actions: [
				{ id: "open", key: "o", hint: rawHint("o", "open"), target: "current" },
				{ id: "branch", key: "b", hint: rawHint("b", "branch"), target: "current" },
				{ id: "delete", key: "d", hint: rawHint("d/delete", "delete"), target: "currentOrSelection" },
				{ id: "updateVisible", key: "u", hint: rawHint("u", "update"), target: "visible" },
			],
			enableFilter: true,
			maxVisible: REFERENCE_VISIBLE_ROWS,
			renderItem: (item, state, width) => this.renderReferenceRow(item, state.active, width),
			searchText: (item) => `${item.name} ${item.branch} ${item.path}`,
			onAction: (result) => this.handleListAction(result),
			onSelectionChange: (selected) => {
				this.selected = selected;
				this.syncPanel();
			},
		});
	}

	private handleListAction(result: MultiSelectActionResult<ReferenceListItem>): void {
		if (result.actionId === "updateVisible") {
			void this.updateVisibleReferences(result.items);
			return;
		}
		if (result.items.length === 0) {
			this.ctx.ui.notify("No reference highlighted or selected.", "info");
			return;
		}

		const [item] = result.items;
		if (!item) return;
		if (result.actionId === "open") this.openReference(item);
		else if (result.actionId === "branch") void this.startBranchPicker(item);
		else if (result.actionId === "delete") this.startDeleteReferences(result.items);
	}

	private renderBody(width: number): string[] {
		if (this.branchPicker) return this.renderBranchPicker(width);
		if (this.cloneInput) return this.renderCloneInput(width);
		return this.list.render(width);
	}

	private renderCloneInput(width: number): string[] {
		const renderWidth = Math.max(1, width);
		return [
			truncateToWidth(this.theme.fg("accent", this.theme.bold("Git URL")), renderWidth, ""),
			...(this.cloneInput?.render(renderWidth) ?? []),
		];
	}

	private renderBranchPicker(width: number): string[] {
		const picker = this.branchPicker;
		if (!picker) return [];
		const renderWidth = Math.max(1, width);
		const window = visibleWindow(picker.cursor, picker.branches.length, BRANCH_VISIBLE_ROWS);
		const lines = [
			truncateToWidth(
				this.theme.fg("accent", this.theme.bold(`Choose branch for ${picker.item.name}`)),
				renderWidth,
				"",
			),
			truncateToWidth(
				this.theme.fg("dim", `${picker.branches.length}/${this.branchChoices} branch choice(s) shown`),
				renderWidth,
				"",
			),
			"",
		];

		for (let index = window.start; index < window.end; index++) {
			const branch = picker.branches[index];
			if (!branch) continue;
			const active = index === picker.cursor;
			const pointer = active ? this.theme.fg("accent", "› ") : "  ";
			const suffix = branch.isCurrent
				? "current"
				: branch.updatedAt === undefined
					? "remote"
					: formatAge(branch.updatedAt);
			const labelText = `${branch.name}  ${suffix}`;
			const label = active
				? this.theme.fg("accent", labelText)
				: this.theme.fg(branch.isCurrent ? "accent" : "text", labelText);
			lines.push(truncateToWidth(`${pointer}${label}`, renderWidth, ""));
		}
		if (window.start > 0 || window.end < picker.branches.length) {
			lines.push(
				this.theme.fg(
					"dim",
					truncateToWidth(`  (${picker.cursor + 1}/${picker.branches.length})`, renderWidth, ""),
				),
			);
		}
		return lines;
	}

	private renderReferenceRow(item: ReferenceListItem, active: boolean, width: number): string[] {
		const name = item.dirty ? `${item.name} *` : item.name;
		const label = active ? this.theme.fg("accent", name) : this.theme.fg(item.dirty ? "warning" : "text", name);
		const branch = item.branch ? this.theme.fg("muted", ` (${item.branch})`) : "";
		const status = item.state
			? ` ${this.theme.fg(item.state === "failed" ? "error" : item.state === "updated" ? "success" : "muted", item.state === "failed" ? "!" : item.state === "updated" ? "✓" : "…")}`
			: "";
		return [truncateToWidth(`${label}${branch}${status}`, width, "")];
	}

	private handleBranchInput(data: string): void {
		const picker = this.branchPicker;
		if (!picker) return;
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) picker.cursor = Math.max(0, picker.cursor - 1);
		else if (keybindings.matches(data, "tui.select.down"))
			picker.cursor = Math.min(picker.branches.length - 1, picker.cursor + 1);
		else if (keybindings.matches(data, "tui.select.confirm")) {
			const branch = picker.branches[picker.cursor];
			if (branch) void this.switchPickedBranch(branch.name);
			return;
		} else if (keybindings.matches(data, "tui.select.cancel")) this.branchPicker = undefined;
		this.syncPanel();
	}

	private handleDeleteConfirmInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm")) {
			const picked = this.deleteConfirm?.items ?? [];
			this.deleteConfirm = undefined;
			void this.deleteReferences(picked);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.deleteConfirm = undefined;
			this.syncPanel();
		}
	}

	private startCloneInput(): void {
		if (this.cloneStatus) {
			this.ctx.ui.notify("Reference clone already running.", "info");
			return;
		}
		this.cloneInput = new Input();
		this.cloneInput.focused = true;
		this.cloneInput.onSubmit = (value) => {
			this.cloneInput = undefined;
			void this.startClone(value);
		};
		this.cloneInput.onEscape = () => {
			this.cloneInput = undefined;
			this.ctx.ui.notify("New reference cancelled.", "info");
			this.syncPanel();
		};
		this.branchPicker = undefined;
		this.deleteConfirm = undefined;
		this.syncPanel();
	}

	private async startClone(input: string): Promise<void> {
		const url = input.trim();
		if (!url) {
			this.ctx.ui.notify("New reference cancelled.", "info");
			this.syncPanel();
			return;
		}

		let name: string;
		try {
			name = referenceNameFromUrl(url);
		} catch (error) {
			this.ctx.ui.notify(errorText(error), "error");
			this.syncPanel();
			return;
		}

		const path = join(REFERENCES_DIR, name);
		if (this.refs.some((item) => item.path === path) || this.cloneStatus?.path === path) {
			this.ctx.ui.notify(`Reference already exists: ${name}`, "error");
			this.syncPanel();
			return;
		}

		this.cloneStatus = { name, path };
		this.syncPanel();
		try {
			await cloneReference(url, name, path, this.ctx.signal, (progress) => {
				if (this.cloneStatus?.path === path) this.cloneStatus.progress = progress;
				this.syncPanel();
			});
			const item = toListItem(await loadReference(this.git, name, path));
			this.refs = [...this.refs, item].sort(compareReferenceItems);
			this.list.setItems(this.refs);
			this.ctx.ui.notify(`Added ${name} to ${path}`, "info");
		} catch (error) {
			this.ctx.ui.notify(`New reference failed: ${errorText(error)}`, "error");
		} finally {
			this.cloneStatus = undefined;
			this.syncPanel();
		}
	}

	private async updateVisibleReferences(items: readonly ReferenceListItem[]): Promise<void> {
		if (this.updating) return;
		if (items.length === 0) {
			this.ctx.ui.notify("No references.", "info");
			return;
		}

		this.updating = true;
		let updated = 0;
		const failures: string[] = [];
		for (const item of items) item.state = "updating";
		this.syncPanel();

		try {
			await Promise.all(
				items.map(async (item) => {
					try {
						await this.git.run(["pull", "--ff-only", "--quiet"], {
							cwd: item.path,
							timeout: UPDATE_TIMEOUT_MS,
						});
						updated += 1;
						item.state = "updated";
					} catch (error) {
						item.state = "failed";
						failures.push(`${item.name}: ${errorText(error)}`);
					}
					this.syncPanel();
				}),
			);
			await this.reloadReferences(true);
		} finally {
			this.updating = false;
			this.syncPanel();
		}

		if (updated > 0) this.ctx.ui.notify(`Updated ${updated} reference(s).`, "info");
		if (failures.length > 0) this.ctx.ui.notify(`Reference update failed:\n${failures.join("\n")}`, "error");
	}

	private async startBranchPicker(item: ReferenceListItem): Promise<void> {
		item.state = "switching";
		this.syncPanel();
		let branches = markCurrent(this.branchCache.get(item.path) ?? [], item.branch);
		try {
			if (branches.length === 0)
				branches = await loadLocalBranches(this.git, item.path, item.branch, this.branchChoices);
		} catch (error) {
			item.state = undefined;
			this.syncPanel();
			this.ctx.ui.notify(`Branch lookup failed: ${errorText(error)}`, "error");
			return;
		}

		item.state = undefined;
		if (branches.length === 0) {
			this.ctx.ui.notify("No remote branches found.", "error");
			this.syncPanel();
			return;
		}

		this.branchPicker = { item, branches, cursor: 0 };
		this.branchCache.set(item.path, branches);
		this.deleteConfirm = undefined;
		this.syncPanel();

		void (async () => {
			try {
				const remoteBranches = await loadRemoteBranches(this.git, item.path, item.branch);
				const merged = mergeBranches(branches, remoteBranches, this.branchChoices);
				this.branchCache.set(item.path, merged);
				if (this.branchPicker?.item.path === item.path) {
					this.branchPicker.branches = merged;
					this.branchPicker.cursor = Math.min(this.branchPicker.cursor, Math.max(0, merged.length - 1));
					this.syncPanel();
				}
			} catch (error) {
				if (this.branchPicker?.item.path === item.path)
					this.ctx.ui.notify(`Remote branch lookup failed: ${errorText(error)}`, "error");
			}
		})();
	}

	private async switchPickedBranch(branch: string): Promise<void> {
		const item = this.branchPicker?.item;
		if (!item) return;
		this.branchPicker = undefined;
		const current = this.refs.find((ref) => ref.path === item.path);
		if (!current) {
			this.ctx.ui.notify("Reference no longer exists.", "error");
			this.syncPanel();
			return;
		}
		current.state = "switching";
		this.syncPanel();
		try {
			await switchBranch(this.git, current.path, branch);
			this.branchCache.delete(current.path);
			await this.reloadReferences();
			this.ctx.ui.notify(`Switched ${current.name} to ${branch}.`, "info");
		} catch (error) {
			current.state = "failed";
			this.syncPanel();
			this.ctx.ui.notify(`Branch switch failed: ${errorText(error)}`, "error");
		}
	}

	private startDeleteReferences(items: readonly ReferenceListItem[]): void {
		if (items.length === 0) {
			this.ctx.ui.notify("No reference highlighted or selected.", "info");
			return;
		}
		this.deleteConfirm = {
			items,
			label: `Delete ${items.length === 1 ? items[0]?.name : `${items.length} repos`}?`,
		};
		this.branchPicker = undefined;
		this.syncPanel();
	}

	private async deleteReferences(items: readonly ReferenceListItem[]): Promise<void> {
		const deleted: string[] = [];
		const failures: string[] = [];
		for (const item of items) {
			try {
				if (!/^[A-Za-z0-9._-]+$/.test(item.name) || item.name === "." || item.name === "..") {
					throw new Error(`Invalid reference name: ${item.name}`);
				}
				const target = join(REFERENCES_DIR, item.name);
				if (!target.startsWith(`${REFERENCES_DIR}/`)) throw new Error(`Invalid reference path: ${item.name}`);
				await rm(target, { recursive: true, force: true });
				deleted.push(item.name);
			} catch (error) {
				failures.push(`${item.name}: ${errorText(error)}`);
			}
		}
		await this.reloadReferences();
		if (deleted.length > 0)
			this.ctx.ui.notify(`Deleted ${deleted.length} reference${deleted.length === 1 ? "" : "s"}.`, "info");
		if (failures.length > 0) this.ctx.ui.notify(`Reference delete failed:\n${failures.join("\n")}`, "error");
	}

	private openReference(item: ReferenceListItem): void {
		const configuredEditor = this.editor === "default" ? undefined : this.editor;
		const defaultEditor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
		const command = configuredEditor ?? defaultEditor;
		const child = command
			? spawn(`${command} ${shellQuote(item.path)}`, { detached: true, shell: true, stdio: "ignore" })
			: spawn("code", [item.path], { detached: true, stdio: "ignore" });
		child.once("error", (error) => this.ctx.ui.notify(`Open reference failed: ${errorText(error)}`, "error"));
		child.once("spawn", () => {
			child.unref();
			this.ctx.ui.notify(`Opening ${item.name}.`, "info");
		});
	}

	private async reloadReferences(preserveStates = false): Promise<void> {
		const states = new Map(preserveStates ? this.refs.map((item) => [item.path, item.state]) : []);
		this.refs = (await loadReferences(this.git)).map((item) => toListItem(item, states.get(item.path)));
		this.list.setItems(this.refs);
		this.syncPanel();
	}

	private syncPanel(): void {
		this.panelConfig.secondary = this.secondaryText();
		this.panelConfig.header = this.headerLines();
		this.panelConfig.footer = this.footer();
		this.tui.requestRender();
	}

	private secondaryText(): string {
		return [
			`${this.refs.length} total`,
			REFERENCES_DIR,
			...(this.selected.length > 0 ? [`${this.selected.length} selected`] : []),
		].join(" · ");
	}

	private headerLines(): readonly string[] {
		const lines: string[] = [];
		if (this.refs.some((item) => item.dirty)) {
			lines.push(this.theme.fg("warning", "Warning: dirty reference repos are read-only."));
		}
		if (this.cloneStatus) {
			const progress = this.cloneStatus.progress
				? ` ${this.cloneStatus.progress.phase} ${this.cloneStatus.progress.percent}%`
				: " starting";
			lines.push(this.theme.fg("muted", `Cloning ${this.cloneStatus.name}${progress}`));
		}
		return lines;
	}

	private footer() {
		if (this.deleteConfirm) {
			return {
				kind: "destructiveAck" as const,
				message: this.deleteConfirm.label,
				hints: [bindingHint("tui.select.confirm", "confirm"), bindingHint("tui.select.cancel", "cancel")],
			};
		}
		return { kind: "hints" as const, hints: this.footerHints() };
	}

	private footerHints() {
		if (this.branchPicker) {
			return [bindingHint("tui.select.confirm", "switch branch"), bindingHint("tui.select.cancel", "cancel")];
		}
		if (this.cloneInput) {
			return [bindingHint("tui.select.confirm", "clone default branch"), bindingHint("tui.select.cancel", "cancel")];
		}
		return [
			...this.list.getKeyHints(),
			rawHint("n", "new"),
			bindingHint("tui.select.confirm", "attach"),
			bindingHint("tui.select.cancel", "cancel"),
		];
	}
}

function compactCurrent(item: ReferenceListItem | undefined): readonly ReferenceListItem[] {
	return item ? [item] : [];
}

function toListItem(item: ReferenceItem, state?: ReferenceListItem["state"]): ReferenceListItem {
	return { ...item, id: item.path, state };
}

function toReferenceItem(item: ReferenceListItem): ReferenceItem {
	return { name: item.name, path: item.path, dirty: item.dirty, branch: item.branch };
}

async function cloneReference(
	url: string,
	name: string,
	target: string,
	signal: AbortSignal | undefined,
	onProgress: (progress: CloneProgress) => void,
): Promise<void> {
	await mkdir(REFERENCES_DIR, { recursive: true });
	if (
		await access(target).then(
			() => true,
			() => false,
		)
	)
		throw new Error(`Reference already exists: ${name}`);
	const temp = join(REFERENCES_DIR, `.clone-${name}-${process.pid}-${Date.now()}`);
	let stderr = "";
	let lastProgress: CloneProgress | undefined;
	let lastOutputAt = Date.now();
	let timedOut = false;

	try {
		const child = spawn("git", ["clone", "--progress", "--single-branch", url, temp], {
			cwd: REFERENCES_DIR,
			stdio: ["ignore", "ignore", "pipe"],
		});
		const stderrStream = child.stderr;
		if (!stderrStream) throw new Error("git clone stderr unavailable.");
		const abort = () => child.kill("SIGTERM");
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });

		await new Promise<void>((resolve, reject) => {
			const timer = setInterval(() => {
				if (Date.now() - lastOutputAt < CLONE_STALL_MS) return;
				timedOut = true;
				child.kill("SIGTERM");
			}, 1000);

			stderrStream.setEncoding("utf8");
			stderrStream.on("data", (chunk: string) => {
				lastOutputAt = Date.now();
				stderr = `${stderr}${chunk}`.slice(-4000);
				for (const part of chunk.split(/[\r\n]+/)) {
					const match = /(?<phase>Receiving objects|Resolving deltas|Updating files):\s+(?<percent>\d+)%/.exec(
						part,
					);
					if (!match) continue;
					const phase = cloneProgressPhase(match.groups?.phase);
					if (!phase) continue;
					lastProgress = { phase, percent: Number(match.groups?.percent ?? 0) };
					onProgress(lastProgress);
				}
			});

			child.once("error", (error) => {
				clearInterval(timer);
				signal?.removeEventListener("abort", abort);
				reject(error);
			});
			child.once("close", (code, termSignal) => {
				clearInterval(timer);
				signal?.removeEventListener("abort", abort);
				if (code === 0) resolve();
				else if (timedOut) {
					reject(
						new Error(
							`Clone stalled after ${Math.round(CLONE_STALL_MS / 1000)}s with no git output${lastProgress === undefined ? "" : ` at ${lastProgress.phase} ${lastProgress.percent}%`}.${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
						),
					);
				} else if (signal?.aborted) reject(new Error("Clone cancelled."));
				else reject(new Error(stderr.trim() || `git clone failed with exit code ${code ?? termSignal}`));
			});
		});

		await rename(temp, target);
	} catch (error) {
		await rm(temp, { recursive: true, force: true });
		throw error;
	}
}

function cloneProgressPhase(phase: string | undefined): CloneProgress["phase"] | undefined {
	if (phase === "Receiving objects") return "receiving";
	if (phase === "Resolving deltas") return "resolving";
	if (phase === "Updating files") return "updating";
	return undefined;
}

function compareReferenceItems(left: ReferenceListItem, right: ReferenceListItem): number {
	return left.name.localeCompare(right.name);
}

async function loadReferences(git: GitRunner): Promise<ReferenceItem[]> {
	await mkdir(REFERENCES_DIR, { recursive: true });
	const refs = (await readdir(REFERENCES_DIR, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".clone-"))
		.map((entry) => ({ name: entry.name, path: join(REFERENCES_DIR, entry.name) }))
		.sort((left, right) => left.name.localeCompare(right.name));

	const references: ReferenceItem[] = [];
	for (const ref of refs) references.push(await loadReference(git, ref.name, ref.path));
	return references;
}

async function loadReference(git: GitRunner, name: string, path: string): Promise<ReferenceItem> {
	const branch = await git.run(["branch", "--show-current"], { cwd: path, optional: true });
	const commit = branch ? "" : await git.run(["rev-parse", "--short", "HEAD"], { cwd: path, optional: true });
	return {
		name,
		path,
		dirty: (await git.run(["status", "--porcelain=v1"], { cwd: path, optional: true })).length > 0,
		branch: branch || (commit ? `detached ${commit}` : ""),
	};
}

async function loadLocalBranches(
	git: GitRunner,
	path: string,
	current: string,
	limit: number,
): Promise<ReferenceBranch[]> {
	const localRefs = await git.run(
		[
			"for-each-ref",
			`--count=${limit}`,
			"--sort=-committerdate",
			"--format=%(refname:strip=3)%00%(committerdate:unix)",
			"refs/remotes/origin",
		],
		{ cwd: path, timeout: BRANCH_LOOKUP_TIMEOUT_MS },
	);
	return parseLocalBranches(localRefs, current).slice(0, limit);
}

async function loadRemoteBranches(git: GitRunner, path: string, current: string): Promise<ReferenceBranch[]> {
	const remoteRefs = await git.run(["ls-remote", "--heads", "origin"], {
		cwd: path,
		timeout: BRANCH_LOOKUP_TIMEOUT_MS,
	});
	return parseRemoteBranchNames(remoteRefs).map((name) => ({ name, isCurrent: name === current }));
}

function mergeBranches(
	localBranches: readonly ReferenceBranch[],
	remoteBranches: readonly ReferenceBranch[],
	limit: number,
): ReferenceBranch[] {
	const byName = new Map(localBranches.map((branch) => [branch.name, branch]));
	for (const branch of remoteBranches) if (!byName.has(branch.name)) byName.set(branch.name, branch);
	return [...byName.values()]
		.sort((left, right) => {
			if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
			if (left.updatedAt !== undefined && right.updatedAt !== undefined) return right.updatedAt - left.updatedAt;
			if (left.updatedAt !== undefined) return -1;
			if (right.updatedAt !== undefined) return 1;
			return left.name.localeCompare(right.name);
		})
		.slice(0, limit);
}

function markCurrent(branches: readonly ReferenceBranch[], current: string): ReferenceBranch[] {
	return branches.map((branch) => ({ ...branch, isCurrent: branch.name === current }));
}

function parseLocalBranches(output: string, current: string): ReferenceBranch[] {
	return output
		.split("\n")
		.filter(Boolean)
		.map((line): ReferenceBranch => {
			const [branchName = "", seconds = "0"] = line.split("\0");
			return { name: branchName, updatedAt: Number(seconds) * 1000, isCurrent: branchName === current };
		})
		.filter((branch) => branch.name && branch.name !== "HEAD")
		.sort((left, right) => {
			if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
			return (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.name.localeCompare(right.name);
		});
}

function parseRemoteBranchNames(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.split("\t")[1]?.replace(/^refs\/heads\//, "") ?? "")
		.filter((name) => name && name !== "HEAD");
}

async function switchBranch(git: GitRunner, path: string, branch: string): Promise<void> {
	const local = await git.run(["branch", "--list", branch], { cwd: path, optional: true });
	if (local.trim()) {
		await git.run(["switch", branch], { cwd: path, timeout: BRANCH_SWITCH_TIMEOUT_MS });
		return;
	}

	const remote = await git.run(["show-ref", "--verify", `refs/remotes/origin/${branch}`], {
		cwd: path,
		optional: true,
		timeout: BRANCH_LOOKUP_TIMEOUT_MS,
	});
	if (!remote.trim()) {
		await git.run(["fetch", "--quiet", "--depth=1", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], {
			cwd: path,
			timeout: BRANCH_SWITCH_TIMEOUT_MS,
		});
	}
	await git.run(["switch", "--track", "-c", branch, `origin/${branch}`], {
		cwd: path,
		timeout: BRANCH_SWITCH_TIMEOUT_MS,
	});
}

function referenceNameFromUrl(url: string): string {
	const name = basename(
		url
			.trim()
			.replace(/[?#].*$/, "")
			.replace(/\/+$/, "")
			.replace(/\.git$/i, ""),
	)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!name || name === "." || name === "..") throw new Error("Could not derive reference folder name from Git URL.");
	return name;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
