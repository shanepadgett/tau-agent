import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { errorText, formatAge, preview } from "../../shared/text.ts";
import { type MultiSelectActionResult, MultiSelectList } from "../../shared/tui/multi-select-list.ts";
import { Tabs } from "../../shared/tui/tabs.ts";
import { rawHint, type ToolKeyHint, textHint } from "../../shared/tui/tool-key-hints.ts";
import { ToolPanel, type ToolPanelConfig } from "../../shared/tui/tool-panel.ts";
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
	private readonly activeList: MultiSelectList<ManagedSession>;
	private readonly archiveList: MultiSelectList<ManagedSession>;
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

	private createList(tab: TabId, items: readonly ManagedSession[]): MultiSelectList<ManagedSession> {
		return new MultiSelectList(this.theme, {
			items,
			emptyMessage: tab === "active" ? "No saved sessions." : "No archived sessions.",
			enableFilter: false,
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
			renderItem: (item, state, width) => this.renderRow(item, state.active, state.selected, width),
			searchText: (item) => `${item.name} ${item.cwd}`,
			onAction: (result) => this.prepareAction(tab, result),
		});
	}

	private handleInput(data: string): void {
		if (this.executing) return;

		if (this.pending) {
			if (matchesKey(data, Key.enter)) {
				void this.confirmPending();
				return;
			}
			if (matchesKey(data, Key.escape)) {
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
		if (data === "s") {
			void this.toggleScope();
			return;
		}
		if (this.tabs.handleKey(data)) {
			this.syncPanel();
			return;
		}

		(this.currentTab() === "active" ? this.activeList : this.archiveList).handleInput(data);
		this.syncPanel();
	}

	private prepareAction(tab: TabId, result: MultiSelectActionResult<ManagedSession>): void {
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
					hints: [rawHint("Enter", "confirm"), rawHint("Esc", "cancel")],
				}
			: { kind: "hints", hints: this.footerHints() };
		this.requestRender();
	}

	private tabItems() {
		return [
			{ id: "active", label: "Sessions", count: this.active.length, body: this.activeList },
			{ id: "archive", label: "Archive", count: this.archive.length, body: this.archiveList },
		];
	}

	private footerHints(): readonly ToolKeyHint[] {
		return [
			...this.tabs.getKeyHints(),
			rawHint("s", this.scope === "current" ? "all projects" : "current folder"),
			...this.listFor(this.currentTab()).getKeyHints(),
			textHint("Enter disabled"),
			rawHint("Esc", "close"),
		];
	}

	private renderRow(item: ManagedSession, active: boolean, selected: boolean, width: number): string[] {
		const pointer = active ? this.theme.fg("accent", "› ") : "  ";
		const box = selected ? "[x]" : "[ ]";
		const age = this.theme.fg("dim", formatAge(item.modified.getTime()));
		const count = item.messageCount > 0 ? this.theme.fg("dim", ` ${item.messageCount} msgs`) : "";
		const suffix = visibleWidth(count) + visibleWidth(age) + 2 < width ? `${count}  ${age}` : age;
		const nameWidth = Math.max(8, width - visibleWidth(`${pointer}${box}  `) - visibleWidth(suffix) - 1);
		const name = this.theme.fg(active ? "accent" : "text", preview(item.name, nameWidth));
		return [truncateToWidth(`${pointer}${box} ${name} ${suffix}`, width, "")];
	}

	private currentTab(): TabId {
		return this.tabs.getActiveId() === "archive" ? "archive" : "active";
	}

	private listFor(tab: TabId): MultiSelectList<ManagedSession> {
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
