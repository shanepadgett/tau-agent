import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { rawHint, SelectableList, ToolPanel } from "@shanepadgett/tau-tui";
import type { Workspace } from "./workspaces.ts";

export function showWorkspacePanel(
	ctx: ExtensionCommandContext,
	workspaces: readonly Workspace[],
): Promise<Workspace | "new" | undefined> {
	const branchOf = (workspace: Workspace) => workspace.branch?.replace(/^refs\/heads\//, "") ?? "detached";
	const nameWidth = Math.min(28, Math.max(0, ...workspaces.map((workspace) => visibleWidth(workspace.name))));
	const branchWidth = Math.min(32, Math.max(0, ...workspaces.map((workspace) => visibleWidth(branchOf(workspace)))));
	return ctx.ui.custom<Workspace | "new" | undefined>((tui, theme, _keys, done) => {
		const cell = (text: string, cellWidth: number) => truncateToWidth(text, cellWidth, "…", true);
		const list = new SelectableList(theme, {
			items: workspaces,
			emptyMessage: "No workspaces found.",
			selection: { kind: "single", primaryLabel: "actions" },
			filter: { searchText: (workspace) => `${workspace.name} ${workspace.branch ?? "detached"} ${workspace.path}` },
			actions: [{ id: "new", key: Key.ctrl("n"), hint: rawHint("ctrl+n", "new") }],
			cancelLabel: "close",
			maxVisible: 8,
			renderItem: (workspace, state, width) => {
				const status = workspace.missing
					? theme.fg("error", "missing")
					: workspace.changes
						? theme.fg("warning", `${workspace.changes} changed`)
						: theme.fg("success", "clean");
				const flags = [
					workspace.current ? theme.fg("accent", "here") : "",
					workspace.owner && !workspace.current ? theme.fg("warning", "in use") : "",
					workspace.locked ? theme.fg("dim", "locked") : "",
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
				else if (result.kind === "action") done("new");
				else done(result.items[0]);
			},
		});
		const config = {
			title: "Worktrees",
			secondary: "One folder and branch per feature",
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
