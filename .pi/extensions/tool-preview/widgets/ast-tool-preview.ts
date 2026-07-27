import { defineTool, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ExploreCallComponent,
	renderExploreResult,
	type ExploreToolDetails,
} from "../../../../packages/agent/extensions/explore/ast/tools/render.ts";
import type { ToolRowStateStore } from "../../../../packages/agent/shared/tool-row-state.ts";
import { addMessageBox, addPageTitle, addSampleTitle, addSection } from "./layout.ts";

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
	truncated?: boolean;
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
				truncated: spec.truncated ?? false,
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
	return defineTool<typeof parameters, ExploreToolDetails>({
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
					truncated: false,
				},
			};
		},
		renderCall(_args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const targets = [spec.target];
			const options = spec.options ? [spec.options] : [];
			const component =
				(context.lastComponent as ExploreCallComponent | undefined) ??
				new ExploreCallComponent(rowState, context.toolCallId, spec.name, targets, options, theme);
			component.targetVariants = targets;
			component.optionVariants = options;
			component.theme = theme;
			return component;
		},
		renderResult(result, options, theme, context) {
			return renderExploreResult(result, options.expanded, theme, context);
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
