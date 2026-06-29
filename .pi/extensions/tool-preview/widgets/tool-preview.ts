import { type Theme, type ToolDefinition, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface ToolPreviewSpec {
	name: string;
	sampleTitle?: string;
	args: Record<string, unknown>;
	argText: string;
	result: string;
	agentResult?: string;
	isError?: boolean;
}

export function createToolPreviewWidget(
	tui: TUI,
	cwd: string,
	theme: Theme,
	title: string,
	specs: ToolPreviewSpec[],
): Container {
	const container = new Container();
	addPageTitle(container, theme, `${toolTitle(title)} Row Preview`);
	for (const spec of specs) {
		if (spec.sampleTitle) addSampleTitle(container, theme, spec.sampleTitle);
		addAgentPreview(container, theme, spec);
		addSection(container, theme, "Initial Call", [createToolRow(tui, cwd, spec, "pending", false)]);
		addSection(container, theme, "Collapsed Result", [createToolRow(tui, cwd, spec, "collapsed", false)]);
		addSection(container, theme, "Expanded Result", [createToolRow(tui, cwd, spec, "expanded", false)]);
	}
	const prunedSpec = specs[0];
	if (prunedSpec) {
		addSampleTitle(container, theme, "Pruned Result");
		addSection(container, theme, "Collapsed", [createToolRow(tui, cwd, prunedSpec, "collapsed", true)]);
		addSection(container, theme, "Expanded", [createToolRow(tui, cwd, prunedSpec, "expanded", true)]);
	}
	return container;
}

function addPageTitle(container: Container, theme: Theme, title: string): void {
	container.addChild(new Text(theme.fg("text", theme.bold(title)), 1, 0));
	container.addChild(new Spacer(1));
}

function addSampleTitle(container: Container, theme: Theme, title: string): void {
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	container.addChild(new Spacer(1));
}

function addSection(container: Container, theme: Theme, title: string, rows: ToolExecutionComponent[]): void {
	addSectionHeading(container, theme, title);
	for (const row of rows) container.addChild(row);
	container.addChild(new Spacer(1));
}

function addAgentPreview(container: Container, theme: Theme, spec: ToolPreviewSpec): void {
	addSectionHeading(container, theme, "Agent Payload");
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageText", spec.agentResult ?? spec.result), 0, 0));
	container.addChild(box);
	container.addChild(new Spacer(1));
}

function addSectionHeading(container: Container, theme: Theme, title: string): void {
	container.addChild(new Text(theme.bold(toTitleCase(title)), 1, 0));
}

function toolTitle(title: string): string {
	return title === "ls" ? "LS" : toTitleCase(title);
}

function toTitleCase(title: string): string {
	return title.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function createToolRow(
	tui: TUI,
	cwd: string,
	spec: ToolPreviewSpec,
	state: "pending" | "collapsed" | "expanded",
	warning: boolean,
): ToolExecutionComponent {
	const row = new ToolExecutionComponent(
		spec.name,
		`${spec.name}-${warning ? "warning" : "normal"}-${state}`,
		spec.args,
		{},
		createDefinition(spec, warning),
		tui,
		cwd,
	);
	row.markExecutionStarted();
	row.setArgsComplete();
	if (state === "pending") return row;

	row.updateResult(
		{ content: [{ type: "text", text: spec.result }], details: undefined, isError: spec.isError ?? false },
		false,
	);
	row.setExpanded(state === "expanded");
	return row;
}

function createDefinition(spec: ToolPreviewSpec, warning: boolean): ToolDefinition {
	return {
		name: spec.name,
		label: spec.name,
		description: "Preview tool row",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "" }], details: undefined };
		},
		renderCall(_args, theme) {
			const title = warning
				? theme.fg("warning", theme.bold(spec.name))
				: theme.fg("toolTitle", theme.bold(spec.name));
			return new Text(`${title} ${theme.fg("muted", spec.argText)}`, 0, 0);
		},
		renderResult(result, { expanded }, _theme, _context) {
			return new Text(expanded ? textContent(result.content) : "", 0, 0);
		},
	};
}

function textContent(content: readonly { type: string }[]): string {
	for (const item of content) {
		if (item.type === "text" && "text" in item && typeof item.text === "string") return item.text;
	}
	return "";
}
