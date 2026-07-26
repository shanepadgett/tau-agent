import { defineTool, formatSize, keyHint, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../../../packages/agent/shared/tool-row-state.ts";
import { addMessageBox, addPageTitle, addSampleTitle, addSection } from "./layout.ts";

interface AstToolPreviewDetails {
	declarationCount: number;
	returnedBytes: number;
	avoidedBytes: number;
	resultNoun: "declaration" | "fresh locator";
}

export interface AstToolPreviewSpec {
	name: string;
	sampleTitle?: string;
	args: Record<string, unknown>;
	target: string;
	options?: string;
	result: string;
	agentResult?: string;
	declarationCount: number;
	returnedBytes: number;
	avoidedBytes: number;
	resultNoun?: "declaration" | "fresh locator";
	isError?: boolean;
}

export function createAstToolPreviewWidget(
	tui: TUI,
	cwd: string,
	theme: Theme,
	title: string,
	specs: AstToolPreviewSpec[],
): Container {
	const container = new Container();
	addPageTitle(container, theme, `${title} Row Preview`);
	for (const spec of specs) {
		if (spec.sampleTitle) addSampleTitle(container, theme, spec.sampleTitle);
		addMessageBox(container, theme, "Agent Payload", spec.agentResult ?? spec.result);
		addSection(container, theme, "Initial Call", [createAstToolRow(tui, cwd, spec, "pending", false)]);
		addSection(container, theme, "Collapsed Result", [createAstToolRow(tui, cwd, spec, "collapsed", false)]);
		addSection(container, theme, "Expanded Result", [createAstToolRow(tui, cwd, spec, "expanded", false)]);
	}
	const prunedSpec = specs[0];
	if (prunedSpec) {
		addSampleTitle(container, theme, "Pruned Result");
		addSection(container, theme, "Collapsed", [createAstToolRow(tui, cwd, prunedSpec, "collapsed", true)]);
		addSection(container, theme, "Expanded", [createAstToolRow(tui, cwd, prunedSpec, "expanded", true)]);
	}
	return container;
}

function createAstToolRow(
	tui: TUI,
	cwd: string,
	spec: AstToolPreviewSpec,
	state: "pending" | "collapsed" | "expanded",
	warning: boolean,
): ToolExecutionComponent {
	const row = new ToolExecutionComponent(
		spec.name,
		`${spec.name}-${warning ? "warning" : "normal"}-${state}`,
		spec.args,
		{},
		createAstPreviewDefinition(spec, warning),
		tui,
		cwd,
	);
	row.markExecutionStarted();
	row.setArgsComplete();
	if (state === "pending") return row;

	row.updateResult(
		{
			content: [{ type: "text", text: spec.result }],
			details: {
				declarationCount: spec.declarationCount,
				returnedBytes: spec.returnedBytes,
				avoidedBytes: spec.avoidedBytes,
				resultNoun: spec.resultNoun ?? "declaration",
			},
			isError: spec.isError ?? false,
		},
		false,
	);
	row.setExpanded(state === "expanded");
	return row;
}

function createAstPreviewDefinition(spec: AstToolPreviewSpec, warning: boolean) {
	const rowState = previewRowState(warning);
	const parameters = Type.Object({});
	return defineTool<typeof parameters, AstToolPreviewDetails>({
		name: spec.name,
		label: spec.name,
		description: "Preview AST tool row",
		parameters,
		async execute() {
			return {
				content: [{ type: "text" as const, text: "" }],
				details: {
					declarationCount: 0,
					returnedBytes: 0,
					avoidedBytes: 0,
					resultNoun: "declaration",
				},
			};
		},
		renderCall(_args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, spec.name, theme);
			const options = spec.options ? ` ${theme.fg("muted", spec.options)}` : "";
			text.setText(`${title}${theme.fg("toolOutput", " → ")}${theme.fg("accent", spec.target)}${options}`);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details;
			if (!options.expanded && !context.isError && details) {
				const noun = details.declarationCount === 1 ? details.resultNoun : `${details.resultNoun}s`;
				const byteSummary = `, ${formatSize(details.returnedBytes)} returned, ${formatSize(details.avoidedBytes)} avoided`;
				text.setText(
					theme.fg("muted", `${details.declarationCount} ${noun}${byteSummary} (`) +
						keyHint("app.tools.expand", "to expand") +
						theme.fg("muted", ")"),
				);
				return text;
			}

			const output = result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			text.setText(
				output
					? output
							.split("\n")
							.map((line) => theme.fg("toolOutput", line))
							.join("\n")
					: "",
			);
			return text;
		},
	});
}

function previewRowState(warning: boolean): ToolRowStateStore {
	return {
		get() {
			return warning ? "pruned" : undefined;
		},
		watch() {},
		clear() {},
	};
}
