import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { rawHint, SelectableList, ToolPanel } from "@shanepadgett/tau-tui";
import type { Workspace } from "./workspaces.ts";

export function showWorkspacePanel(
	ctx: ExtensionCommandContext,
	workspaces: readonly Workspace[],
): Promise<Workspace | "new" | undefined> {
	return ctx.ui.custom<Workspace | "new" | undefined>((tui, theme, _keys, done) => {
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
					? "missing"
					: workspace.changes
						? `${workspace.changes} changed files`
						: "clean";
				const flags = [
					workspace.current ? "here" : "",
					workspace.owner && !workspace.current ? "in use" : "",
					workspace.locked ? "locked" : "",
				].filter(Boolean);
				return [
					truncateToWidth(theme.fg(state.active ? "accent" : "text", workspace.name), width, ""),
					truncateToWidth(
						theme.fg(
							"dim",
							`${workspace.branch?.replace(/^refs\/heads\//, "") ?? "detached"} · ${status}${flags.length ? ` · ${flags.join(" · ")}` : ""}`,
						),
						width,
						"",
					),
				];
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
