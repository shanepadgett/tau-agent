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
	"*** Add File: docs/tool-preview-example.md",
	"+export const exploreExtension = {};",
	"*** Replace File: packages/agent/extensions/explore/README.md",
	"+# Explore",
	"+",
	"+Explore repository files.",
	"*** Update File: packages/agent/extensions/tau-help/index.ts",
	" export const searchExtension = defineExtension({",
	'-\tname: "search",',
	'+\tname: "explore",',
	" });",
	"*** Delete File: docs/obsolete-guide.md",
	"*** Update File: docs/draft-guide.md",
	"*** Move to: docs/published-guide.md",
	'import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";',
	"*** End Patch",
].join("\n");

const partialFailureInput = [
	"*** Begin Patch",
	"*** Add File: docs/example-settings.md",
	"+export const EXPLORE_LIMIT = 100;",
	"*** Update File: packages/agent/extensions/tau-help/index.ts",
	"@@ old registration block",
	'-\tname: "search",',
	'+\tname: "explore",',
	"*** Delete File: docs/obsolete-example.md",
	"*** End Patch",
].join("\n");

const failedInput = [
	"*** Begin Patch",
	"*** Update File: docs/missing-example.md",
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
			path: "docs/tool-preview-example.md",
			linesAdded: 1,
			linesRemoved: 0,
			resultingFingerprint: "sha256:preview-add",
		},
		{
			sectionIndex: 2,
			kind: "replace",
			path: "packages/agent/extensions/explore/README.md",
			linesAdded: 3,
			linesRemoved: 7,
			resultingFingerprint: "sha256:preview-replace",
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
			path: "docs/tool-preview-example.md",
			linesAdded: 1,
			linesRemoved: 0,
			resultingFingerprint: "sha256:preview-add",
		},
		{
			sectionIndex: 2,
			kind: "replace",
			path: "packages/agent/extensions/explore/README.md",
			linesAdded: 3,
			linesRemoved: 7,
			resultingFingerprint: "sha256:preview-replace",
		},
		{
			sectionIndex: 3,
			kind: "update",
			path: "packages/agent/extensions/tau-help/index.ts",
			linesAdded: 1,
			linesRemoved: 1,
			resultingFingerprint: "sha256:preview-update",
		},
		{
			sectionIndex: 4,
			kind: "delete",
			path: "docs/obsolete-guide.md",
			linesAdded: 0,
			linesRemoved: 42,
			resultingFingerprint: null,
		},
		{
			sectionIndex: 5,
			kind: "update",
			path: "docs/published-guide.md",
			move: { from: "docs/draft-guide.md", to: "docs/published-guide.md" },
			linesAdded: 0,
			linesRemoved: 0,
			resultingFingerprint: "sha256:preview-move",
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
			path: "docs/example-settings.md",
			linesAdded: 1,
			linesRemoved: 0,
			resultingFingerprint: "sha256:preview-settings",
		},
		{
			sectionIndex: 3,
			kind: "delete",
			path: "docs/obsolete-example.md",
			linesAdded: 0,
			linesRemoved: 31,
			resultingFingerprint: null,
		},
	],
	failures: [
		{
			phase: "apply",
			sectionIndex: 2,
			path: "packages/agent/extensions/tau-help/index.ts",
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
			path: "docs/missing-example.md",
			kind: "update",
			message: "Path does not exist: docs/missing-example.md",
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
