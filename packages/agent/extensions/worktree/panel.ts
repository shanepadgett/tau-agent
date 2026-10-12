import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bindingHint, SelectableList, ToolPanel } from "@shanepadgett/tau-tui";
import type { Workspace } from "./workspaces.ts";

export function showWorkspaceNameInput(ctx: ExtensionCommandContext): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
		const input = new Input({ placeholder: "e.g. fix-cache-bug", placeholderStyle: (text) => theme.fg("dim", text) });
		input.onSubmit = (value) => done(value);
		input.onEscape = () => done(undefined);
		const panel = new ToolPanel(theme, {
			title: "New worktree",
			secondary: "Name becomes a lowercase, hyphenated folder and wt/<name> branch.",
			body: input,
			footer: {
				kind: "hints",
				hints: [bindingHint("tui.input.submit", "create"), bindingHint("tui.select.cancel", "cancel")],
			},
		});
		return {
			render: (width) => panel.render(width),
			invalidate: () => panel.invalidate(),
			handleInput: (data) => {
				input.handleInput(data);
				tui.requestRender();
			},
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
		};
	});
}

export function showWorkspacePanel(
	ctx: ExtensionCommandContext,
	workspaces: readonly Workspace[],
): Promise<Workspace | undefined> {
	const branchOf = (workspace: Workspace) => workspace.branch?.replace(/^refs\/heads\//, "") ?? "detached";
	const nameWidth = Math.min(28, Math.max(0, ...workspaces.map((workspace) => visibleWidth(workspace.name))));
	const branchWidth = Math.min(32, Math.max(0, ...workspaces.map((workspace) => visibleWidth(branchOf(workspace)))));
	return ctx.ui.custom<Workspace | undefined>((tui, theme, _keys, done) => {
		const cell = (text: string, cellWidth: number) => truncateToWidth(text, cellWidth, "…", true);
		const list = new SelectableList(theme, {
			items: workspaces,
			emptyMessage: "No workspaces found.",
			selection: { kind: "single", primaryLabel: "actions" },
			filter: { searchText: (workspace) => `${workspace.name} ${workspace.branch ?? "detached"} ${workspace.path}` },
			actions: [],
			cancelLabel: "close",
			maxVisible: 8,
			renderItem: (workspace, state, width) => {
				const status = workspace.missing
					? theme.fg("error", "missing")
					: workspace.errors.length
						? theme.fg("error", "error")
						: workspace.changes
							? theme.fg("warning", `${workspace.changes} changed`)
							: theme.fg("success", "clean");
				const flags = [
					workspace.current ? theme.fg("accent", "here") : "",
					workspace.owner && !workspace.current ? theme.fg("warning", "in use") : "",
					workspace.locked ? theme.fg("dim", "locked") : "",
					workspace.missing && workspace.errors.length ? theme.fg("error", "error") : "",
				].filter(Boolean);
				const line = [
					theme.fg(state.active ? "accent" : "text", cell(workspace.name, nameWidth)),
					theme.fg("dim", cell(branchOf(workspace), branchWidth)),
					cell(status, 12),
					...flags,
				].join(theme.fg("dim", "  "));
				return [truncateToWidth(line, width, "")];
			},
			onResult: (result) => {
				if (result.kind === "cancel") done(undefined);
				else if (result.kind === "primary") done(result.items[0]);
			},
		});
		const config = {
			title: "Worktrees",
			secondary: "Switch between the main checkout and worktree sessions",
			body: list,
			footer: { kind: "hints" as const, hints: list.getKeyHints() },
		};
		const panel = new ToolPanel(theme, config);
		return {
			render: (width) => panel.render(width),
			invalidate: () => panel.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				config.footer.hints = list.getKeyHints();
				tui.requestRender();
			},
			get focused() {
				return list.focused;
			},
			set focused(value: boolean) {
				list.focused = value;
			},
		};
	});
}
