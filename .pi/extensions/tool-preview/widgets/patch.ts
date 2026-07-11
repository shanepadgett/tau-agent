import { defineTool, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ApplyPatchSummary } from "../../../../packages/agent/extensions/patch/executor.ts";
import { renderPatchCall, renderPatchResult } from "../../../../packages/agent/extensions/patch/render.ts";
import { formatPatchSummary } from "../../../../packages/agent/extensions/patch/summary.ts";
import type { ToolRowStateStore } from "../../../../packages/agent/shared/tool-row-state.ts";
import { addMessageBox, addPageTitle, addSampleTitle, addSection } from "./layout.ts";

interface PatchPreviewSpec {
	title: string;
	input: string;
	agentPayload: string;
	summary?: ApplyPatchSummary;
	isPartial?: boolean;
	isError?: boolean;
}

interface PatchRenderContext {
	expanded: boolean;
	executionStarted: boolean;
	isPartial: boolean;
	lastComponent?: unknown;
	toolCallId: string;
	invalidate: () => void;
}

const patchPreviewParams = Type.Object({ input: Type.String() });

const mixedPatchInput = [
	"*** Begin Patch",
	"*** Add File: src/extensions/explore/index.ts",
	"+export const exploreExtension = {};",
	"*** Replace File: src/extensions/explore/README.md",
	"+# Explore",
	"+",
	"+Explore repository files.",
	"*** Update File: src/extensions/search/index.ts",
	" export const searchExtension = defineExtension({",
	'-\tname: "search",',
	'+\tname: "explore",',
	" });",
	"*** Delete File: src/extensions/search/forget.ts",
	"*** Update File: src/extensions/search/read.ts",
	"*** Move to: src/extensions/explore/read.ts",
	'import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";',
	"*** End Patch",
].join("\n");

const partialFailureInput = [
	"*** Begin Patch",
	"*** Add File: src/extensions/explore/settings.ts",
	"+export const EXPLORE_LIMIT = 100;",
	"*** Update File: src/extensions/search/index.ts",
	"@@ old registration block",
	'-\tname: "search",',
	'+\tname: "explore",',
	"*** Delete File: src/extensions/search/obsolete.ts",
	"*** End Patch",
].join("\n");

const failedInput = [
	"*** Begin Patch",
	"*** Update File: src/extensions/explore/missing.ts",
	" export const missing = true;",
	"*** End Patch",
].join("\n");

const runningSummary: ApplyPatchSummary = {
	status: "partial",
	totalSections: 5,
	changes: [
		{
			sectionIndex: 1,
			kind: "add",
			path: "src/extensions/explore/index.ts",
			linesAdded: 1,
			linesRemoved: 0,
		},
		{
			sectionIndex: 2,
			kind: "replace",
			path: "src/extensions/explore/README.md",
			linesAdded: 3,
			linesRemoved: 7,
		},
	],
	failures: [],
};

const completedSummary: ApplyPatchSummary = {
	status: "completed",
	totalSections: 5,
	changes: [
		{
			sectionIndex: 1,
			kind: "add",
			path: "src/extensions/explore/index.ts",
			linesAdded: 1,
			linesRemoved: 0,
		},
		{
			sectionIndex: 2,
			kind: "replace",
			path: "src/extensions/explore/README.md",
			linesAdded: 3,
			linesRemoved: 7,
		},
		{
			sectionIndex: 3,
			kind: "update",
			path: "src/extensions/search/index.ts",
			linesAdded: 1,
			linesRemoved: 1,
		},
		{
			sectionIndex: 4,
			kind: "delete",
			path: "src/extensions/search/forget.ts",
			linesAdded: 0,
			linesRemoved: 42,
		},
		{
			sectionIndex: 5,
			kind: "update",
			path: "src/extensions/explore/read.ts",
			move: { from: "src/extensions/search/read.ts", to: "src/extensions/explore/read.ts" },
			linesAdded: 0,
			linesRemoved: 0,
		},
	],
	failures: [],
};

const partialFailureSummary: ApplyPatchSummary = {
	status: "partial",
	totalSections: 3,
	changes: [
		{
			sectionIndex: 1,
			kind: "add",
			path: "src/extensions/explore/settings.ts",
			linesAdded: 1,
			linesRemoved: 0,
		},
		{
			sectionIndex: 3,
			kind: "delete",
			path: "src/extensions/search/obsolete.ts",
			linesAdded: 0,
			linesRemoved: 31,
		},
	],
	failures: [
		{
			phase: "apply",
			sectionIndex: 2,
			path: "src/extensions/search/index.ts",
			kind: "update",
			chunkIndex: 1,
			totalChunks: 1,
			contextHint: "old registration block",
			message: "could not match",
		},
	],
};

const failedSummary: ApplyPatchSummary = {
	status: "failed",
	totalSections: 1,
	changes: [],
	failures: [
		{
			phase: "apply",
			sectionIndex: 1,
			path: "src/extensions/explore/missing.ts",
			kind: "update",
			message: "Path does not exist: src/extensions/explore/missing.ts",
		},
	],
};

function createPatchPreviewDefinition(warning: boolean) {
	const rowState = previewRowState(warning);
	return defineTool<typeof patchPreviewParams, ApplyPatchSummary, unknown>({
		name: "patch",
		label: "Patch",
		description: "Preview patch row",
		parameters: patchPreviewParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return { content: [{ type: "text" as const, text: "" }], details: failedSummary };
		},
		renderCall(args, theme, context) {
			return renderPatchCall(args, theme, renderContext(context, rowState));
		},
		renderResult(result, options, theme, context) {
			return renderPatchResult(result, { expanded: options.expanded }, theme, {
				expanded: options.expanded,
				args: context.args,
				lastComponent: context.lastComponent,
				rowState,
				rowId: context.toolCallId,
				invalidate: context.invalidate,
			});
		},
	});
}

const patchSpecs: PatchPreviewSpec[] = [
	{
		title: "Streaming Input",
		input: mixedPatchInput,
		agentPayload: "[No tool result yet. The agent has sent the patch input; execution has not returned.]",
	},
	{
		title: "Running Partial Update",
		input: mixedPatchInput,
		summary: runningSummary,
		isPartial: true,
		agentPayload: ["[UI partial update; not final model input]", "", formatPatchSummary(runningSummary)].join("\n"),
	},
	{
		title: "Completed Result",
		input: mixedPatchInput,
		summary: completedSummary,
		agentPayload: formatPatchSummary(completedSummary),
	},
	{
		title: "Partial Failure Result",
		input: partialFailureInput,
		summary: partialFailureSummary,
		isError: true,
		agentPayload: formatPatchSummary(partialFailureSummary),
	},
	{
		title: "Failed Result",
		input: failedInput,
		summary: failedSummary,
		isError: true,
		agentPayload: formatPatchSummary(failedSummary),
	},
];

export function createPatchPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	const container = new Container();
	addPageTitle(container, theme, "Patch Row Preview");
	for (const spec of patchSpecs) {
		addSampleTitle(container, theme, spec.title);
		addMessageBox(container, theme, "Agent Payload", spec.agentPayload);
		addSection(container, theme, "Collapsed Row", [createPatchRow(tui, cwd, spec, false)]);
		addSection(container, theme, "Expanded Row", [createPatchRow(tui, cwd, spec, true)]);
	}
	const prunedSpec = patchSpecs[2];
	if (prunedSpec) {
		addSampleTitle(container, theme, "Pruned Result");
		addSection(container, theme, "Collapsed", [createPatchRow(tui, cwd, prunedSpec, false, true)]);
		addSection(container, theme, "Expanded", [createPatchRow(tui, cwd, prunedSpec, true, true)]);
	}
	return container;
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

function renderContext(context: PatchRenderContext, rowState: ToolRowStateStore) {
	return {
		expanded: context.expanded,
		executionStarted: context.executionStarted,
		isPartial: context.isPartial,
		lastComponent: context.lastComponent,
		rowState,
		rowId: context.toolCallId,
		invalidate: context.invalidate,
	};
}

function createPatchRow(
	tui: TUI,
	cwd: string,
	spec: PatchPreviewSpec,
	expanded: boolean,
	warning = false,
): ToolExecutionComponent {
	const row = new ToolExecutionComponent(
		"patch",
		`patch-${warning ? "warning-" : ""}${spec.title.toLowerCase().replaceAll(" ", "-")}-${expanded ? "expanded" : "collapsed"}`,
		{ input: spec.input },
		{},
		createPatchPreviewDefinition(warning),
		tui,
		cwd,
	);
	if (spec.summary) {
		row.markExecutionStarted();
		row.setArgsComplete();
		row.updateResult(
			{
				content: [{ type: "text", text: spec.agentPayload }],
				details: spec.summary,
				isError: spec.isError ?? false,
			},
			spec.isPartial ?? false,
		);
	}
	row.setExpanded(expanded);
	return row;
}
