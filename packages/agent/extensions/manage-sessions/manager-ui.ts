import { homedir } from "node:os";
import { relative } from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { errorText, formatAge, preview } from "../../shared/text.ts";
import { bindingHint, rawHint, type ToolKeyHint } from "@shanepadgett/tau-tui";
import { type SelectableListActionResult, SelectableList } from "@shanepadgett/tau-tui";
import { Tabs } from "@shanepadgett/tau-tui";
import { ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";
import {
	archiveSession,
	deleteSessionFile,
	getArchiveRoot,
	listManagedSessions,
	type ManagedSession,
	type SessionScope,
	unarchiveSession,
} from "./sessions.ts";

type TabId = "active" | "archive";
type PendingKind = "archive" | "delete" | "unarchive";

interface PendingAction {
	kind: PendingKind;
	items: readonly ManagedSession[];
	tab: TabId;
}

export async function showSessionManager(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Session manager requires TUI mode.", "error");
		return;
	}

	const currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	const initial = await listManagedSessions(ctx.cwd, "current", currentSessionFile);

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const manager = new SessionManagerPanel(
			ctx,
			theme,
			currentSessionFile,
			initial,
			() => done(undefined),
			() => tui.requestRender(),
		);
		return manager.component;
	});
}

class SessionManagerPanel {
	readonly component: Component;
	private scope: SessionScope = "current";
	private active: readonly ManagedSession[];
	private archive: readonly ManagedSession[];
	private pending: PendingAction | undefined;
	private executing = false;
	private readonly ctx: ExtensionCommandContext;
	private readonly theme: Theme;
	private readonly currentSessionFile: string | undefined;
	private readonly done: () => void;
	private readonly requestRender: () => void;
	private readonly activeList: SelectableList<ManagedSession>;
	private readonly archiveList: SelectableList<ManagedSession>;
	private readonly tabs: Tabs;
	private readonly panelConfig: ToolPanelConfig;

	constructor(
		ctx: ExtensionCommandContext,
		theme: Theme,
		currentSessionFile: string | undefined,
		initial: { active: readonly ManagedSession[]; archive: readonly ManagedSession[] },
		done: () => void,
		requestRender: () => void,
	) {
		this.ctx = ctx;
		this.theme = theme;
		this.currentSessionFile = currentSessionFile;
		this.done = done;
		this.requestRender = requestRender;
		this.active = initial.active;
		this.archive = initial.archive;
		this.activeList = this.createList("active", this.active);
		this.archiveList = this.createList("archive", this.archive);
		this.tabs = new Tabs(theme, this.tabItems(), "active");
		this.panelConfig = {
			title: "Manage sessions",
			secondary: this.secondaryText(),
			body: this.tabs,
			footer: { kind: "hints", hints: this.footerHints() },
		};
		const panel = new ToolPanel(theme, this.panelConfig);
		this.component = {
			render: (width) => panel.render(width),
			invalidate: () => panel.invalidate(),
			handleInput: (data) => this.handleInput(data),
		};
	}

	private createList(tab: TabId, items: readonly ManagedSession[]): SelectableList<ManagedSession> {
		return new SelectableList(this.theme, {
			items,
			emptyMessage: tab === "active" ? "No saved sessions." : "No archived sessions.",
			selection: { kind: "multi" },
			maxVisible: 14,
			actions:
				tab === "active"
					? [
							{ id: "archive", key: "a", hint: rawHint("a", "archive"), target: "currentOrSelection" },
							{
								id: "archiveOlder",
								key: Key.shift("a"),
								hint: rawHint("A", "archive older"),
								target: "olderThanCursor",
							},
							{ id: "delete", key: "d", hint: rawHint("d", "delete"), target: "currentOrSelection" },
							{
								id: "deleteOlder",
								key: Key.shift("d"),
								hint: rawHint("D", "delete older"),
								target: "olderThanCursor",
							},
						]
					: [
							{ id: "unarchive", key: "u", hint: rawHint("u", "unarchive"), target: "currentOrSelection" },
							{
								id: "unarchiveOlder",
								key: Key.shift("u"),
								hint: rawHint("U", "unarchive older"),
								target: "olderThanCursor",
							},
							{ id: "delete", key: "d", hint: rawHint("d", "delete"), target: "currentOrSelection" },
							{
								id: "deleteOlder",
								key: Key.shift("d"),
								hint: rawHint("D", "delete older"),
								target: "olderThanCursor",
							},
						],
			renderItem: (item, state, width) => this.renderRow(item, state.active, width),
			onResult: (result) => {
				if (result.kind === "action") this.prepareAction(tab, result);
			},
			onSelectionChange: () => {},
		});
	}

	private handleInput(data: string): void {
		if (this.executing) return;
		const keybindings = getKeybindings();

		if (this.pending) {
			if (keybindings.matches(data, "tui.select.confirm")) {
				void this.confirmPending();
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				this.pending = undefined;
				this.syncPanel();
				return;
			}
			return;
		}

		if (matchesKey(data, Key.enter)) return;
		if (matchesKey(data, Key.escape)) {
			this.done();
			return;
		}
		if (matchesKey(data, "s")) {
			void this.toggleScope();
			return;
		}

		this.tabs.handleInput(data);
		this.syncPanel();
	}

	private prepareAction(tab: TabId, result: SelectableListActionResult<ManagedSession>): void {
		if (result.items.length === 0) {
			this.ctx.ui.notify(
				result.target === "olderThanCursor" ? "No older sessions." : "No sessions selected.",
				"info",
			);
			return;
		}

		const kind = result.actionId.startsWith("archive")
			? "archive"
			: result.actionId.startsWith("unarchive")
				? "unarchive"
				: "delete";
		this.pending = { kind, items: result.items, tab };
		this.syncPanel();
	}

	private async confirmPending(): Promise<void> {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		this.executing = true;

		let failures = 0;
		for (const session of pending.items) {
			try {
				if (pending.kind === "archive") await archiveSession(session.path);
				else if (pending.kind === "unarchive") await unarchiveSession(session.path);
				else await deleteSessionFile(session.path);
			} catch (error) {
				failures++;
				this.ctx.ui.notify(`${preview(session.name, 40)}: ${errorText(error)}`, "error");
			}
		}

		await this.reload();
		this.listFor(pending.tab).clearSelection();
		this.executing = false;
		this.ctx.ui.notify(
			this.resultMessage(pending.kind, pending.items.length - failures, failures),
			failures ? "error" : "info",
		);
		this.syncPanel();
	}

	private async toggleScope(): Promise<void> {
		this.scope = this.scope === "current" ? "all" : "current";
		this.activeList.clearSelection();
		this.archiveList.clearSelection();
		await this.reload();
		this.syncPanel();
	}

	private async reload(): Promise<void> {
		try {
			const sessions = await listManagedSessions(this.ctx.cwd, this.scope, this.currentSessionFile);
			this.active = sessions.active;
			this.archive = sessions.archive;
			this.activeList.setItems(this.active);
			this.archiveList.setItems(this.archive);
			this.tabs.setTabs(this.tabItems());
		} catch (error) {
			this.ctx.ui.notify(`Could not load sessions: ${errorText(error)}`, "error");
		}
	}

	private syncPanel(): void {
		this.panelConfig.secondary = this.secondaryText();
		this.panelConfig.footer = this.pending
			? {
					kind: "destructiveAck",
					message: this.pendingMessage(this.pending),
					hints: [bindingHint("tui.select.confirm", "confirm"), bindingHint("tui.select.cancel", "cancel")],
				}
			: { kind: "hints", hints: this.footerHints() };
		this.requestRender();
	}

	private tabItems() {
		return [
			{
				id: "active",
				label: "Sessions",
				count: this.active.length,
				body: this.activeList,
				getKeyHints: () => this.activeList.getKeyHints(),
			},
			{
				id: "archive",
				label: "Archive",
				count: this.archive.length,
				body: this.archiveList,
				getKeyHints: () => this.archiveList.getKeyHints(),
			},
		];
	}

	private footerHints(): readonly ToolKeyHint[] {
		return [
			...this.tabs.getKeyHints(),
			rawHint("s", this.scope === "current" ? "all projects" : "current folder"),
			bindingHint("tui.select.cancel", "close"),
		];
	}

	private renderRow(item: ManagedSession, active: boolean, width: number): string[] {
		const path = this.scope === "all" && item.cwd ? shortenPath(item.cwd) : undefined;
		const age = formatAge(item.modified.getTime());
		const count = item.messageCount > 0 ? `${item.messageCount} msgs` : undefined;
		const requiredSuffix = [path, age].filter((part) => part !== undefined).join("  ");
		const fullSuffix = [path, count, age].filter((part) => part !== undefined).join("  ");
		const fullSuffixFits = visibleWidth(fullSuffix) + 9 <= width;
		const suffix = this.theme.fg("dim", count && fullSuffixFits ? fullSuffix : requiredSuffix);
		const nameWidth = Math.max(8, width - visibleWidth(suffix) - 1);
		const name = this.theme.fg(active ? "accent" : "text", preview(item.name, nameWidth));
		return [truncateToWidth(`${name} ${suffix}`, width, "")];
	}

	private listFor(tab: TabId): SelectableList<ManagedSession> {
		return tab === "active" ? this.activeList : this.archiveList;
	}

	private secondaryText(): string {
		return `scope: ${this.scope === "current" ? "current folder" : "all projects"} · archive: ${getArchiveRoot()}`;
	}

	private pendingMessage(action: PendingAction): string {
		const verb = action.kind === "archive" ? "Archive" : action.kind === "unarchive" ? "Unarchive" : "Delete";
		return `${verb} ${action.items.length} session${action.items.length === 1 ? "" : "s"}?`;
	}

	private resultMessage(kind: PendingKind, count: number, failures: number): string {
		const verb = kind === "archive" ? "Archived" : kind === "unarchive" ? "Unarchived" : "Deleted";
		const base = `${verb} ${count} session${count === 1 ? "" : "s"}.`;
		return failures > 0 ? `${base} ${failures} failed.` : base;
	}
}

function shortenPath(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
	return cwd;
}
