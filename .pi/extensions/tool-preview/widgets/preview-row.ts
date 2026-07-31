import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

type PreviewToolDefinition = ConstructorParameters<typeof ToolExecutionComponent>[4];

/** Builds one settled (or pending) tool row for the preview pages. */
export function buildPreviewRow(options: {
	tui: TUI;
	cwd: string;
	name: string;
	args: Record<string, unknown>;
	definition: PreviewToolDefinition;
	state: "pending" | "collapsed" | "expanded";
	warning: boolean;
	result: { content: Array<{ type: "text"; text: string }>; details: unknown; isError: boolean };
}): ToolExecutionComponent {
	const row = new ToolExecutionComponent(
		options.name,
		`${options.name}-${options.warning ? "warning" : "normal"}-${options.state}`,
		options.args,
		{},
		options.definition,
		options.tui,
		options.cwd,
	);
	row.markExecutionStarted();
	row.setArgsComplete();
	if (options.state === "pending") return row;
	row.updateResult(options.result, false);
	row.setExpanded(options.state === "expanded");
	return row;
}
