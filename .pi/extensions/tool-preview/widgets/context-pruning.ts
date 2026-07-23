import { defineTool, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	contextPruneParameters,
	type ContextPruneInput,
} from "../../../../packages/agent/extensions/context-pruning/prune.ts";
import {
	renderContextPruneCall,
	renderContextPruneResult,
	renderContextPruningNudge,
	type ContextPruningNudgeDetailsV2,
} from "../../../../packages/agent/extensions/context-pruning/render.ts";
import type { ContextPruneDetailsV1 } from "../../../../packages/agent/shared/context-pruning-state.ts";
import type { ToolRowStateStore } from "../../../../packages/agent/shared/tool-row-state.ts";
import { addMessageBox, addPageTitle, addSampleTitle, addSection } from "./layout.ts";

const input: ContextPruneInput = {
	keepFiles: [{ path: "packages/agent/extensions/context-pruning/index.ts", relevance: "active wiring" }],
	keepToolCalls: [{ toolCallId: "patch-42", relevance: "the applied chronology matters" }],
	deferFiles: [{ path: "docs/alternatives.md", reason: "fallback only", relevantWhen: "the primary design fails" }],
};

const applied: ContextPruneDetailsV1 = {
	v: 1,
	status: "applied",
	anchorToolCallId: "context-prune-preview",
	newlyPrunedToolCallIds: ["grep-18", "read-19", "bash-20"],
	newlyPrunedAutoreadRowIds: ["autoread-7"],
	retainedToolCallIds: ["patch-42"],
	retainedAutoreadRowIds: ["context-prune-preview:0"],
	refreshedFiles: [
		{
			path: "packages/agent/extensions/context-pruning/index.ts",
			rowId: "context-prune-preview:0",
			servedHash: "3d7f8d8f",
		},
	],
	deferredFiles: [{ path: "docs/alternatives.md", reason: "fallback only", relevantWhen: "the primary design fails" }],
	tokensBefore: 42_000,
	tokensAfter: 23_000,
	tokensReclaimed: 19_000,
};

const skipped: ContextPruneDetailsV1 = {
	...applied,
	status: "skipped",
	newlyPrunedToolCallIds: [],
	newlyPrunedAutoreadRowIds: [],
	retainedToolCallIds: [],
	retainedAutoreadRowIds: [],
	refreshedFiles: [],
	deferredFiles: [],
	tokensBefore: 12_000,
	tokensAfter: 10_500,
	tokensReclaimed: 1_500,
};

export function createContextPruningPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	const container = new Container();
	addPageTitle(container, theme, "Context Pruning Preview");
	addNudgeStory(container, theme, "Informational Nudge", {
		v: 2,
		kind: "automatic",
		percent: 20,
		boundary: 20,
		reminder: 1,
		tier: 1,
		tierCount: 3,
		tierFloor: 0,
		anchorToolCallId: null,
		growthBaselinePercent: 0,
	});
	addNudgeStory(container, theme, "Prune Soon Nudge", {
		v: 2,
		kind: "automatic",
		percent: 40,
		boundary: 40,
		reminder: 2,
		tier: 2,
		tierCount: 3,
		tierFloor: 1,
		anchorToolCallId: null,
		growthBaselinePercent: 0,
	});
	addNudgeStory(container, theme, "Prune Now Nudge", {
		v: 2,
		kind: "automatic",
		percent: 60,
		boundary: 60,
		reminder: 3,
		tier: 3,
		tierCount: 3,
		tierFloor: 2,
		anchorToolCallId: null,
		growthBaselinePercent: 0,
	});
	addNudgeStory(container, theme, "Manual Request", {
		v: 2,
		kind: "manual",
		percent: null,
		boundary: null,
		reminder: null,
		tier: null,
		tierCount: null,
		tierFloor: null,
		anchorToolCallId: null,
		growthBaselinePercent: null,
	});
	addToolStory(container, tui, cwd, theme, "Applied Prune", applied, false);
	addToolStory(container, tui, cwd, theme, "Skipped Prune", skipped, false);
	addToolStory(container, tui, cwd, theme, "Pruned Warning Row", applied, true);
	return container;
}

function addNudgeStory(container: Container, theme: Theme, title: string, details: ContextPruningNudgeDetailsV2): void {
	addSampleTitle(container, theme, title);
	addMessageBox(
		container,
		theme,
		"Agent Payload",
		"[Internal context-management steering hidden by the marker renderer]",
	);
	const marker = renderContextPruningNudge(details, theme);
	addSection(container, theme, "Visible Marker", [marker ?? new Text("Invalid marker details", 0, 0)]);
}

function addToolStory(
	container: Container,
	tui: TUI,
	cwd: string,
	theme: Theme,
	title: string,
	details: ContextPruneDetailsV1,
	warning: boolean,
): void {
	addSampleTitle(container, theme, title);
	const resultText =
		details.status === "applied"
			? "Prune applied: reclaimed about 19000 tokens. Continue with the next action stated before this call."
			: "Prune skipped: estimated reclaim is below the configured minimum. Continue without immediately retrying.";
	addMessageBox(container, theme, "Agent Payload", resultText);
	addSection(container, theme, "Collapsed Row", [createPruneRow(tui, cwd, details, resultText, false, warning)]);
	addSection(container, theme, "Expanded Row", [createPruneRow(tui, cwd, details, resultText, true, warning)]);
}

function createPruneRow(
	tui: TUI,
	cwd: string,
	details: ContextPruneDetailsV1,
	resultText: string,
	expanded: boolean,
	warning: boolean,
): ToolExecutionComponent {
	const row = new ToolExecutionComponent(
		"context_prune",
		`context-prune-${details.status}-${warning ? "warning" : "normal"}-${expanded ? "expanded" : "collapsed"}`,
		input,
		{},
		createPreviewDefinition(previewRowState(warning)),
		tui,
		cwd,
	);
	row.markExecutionStarted();
	row.setArgsComplete();
	row.updateResult({ content: [{ type: "text", text: resultText }], details, isError: false }, false);
	row.setExpanded(expanded);
	return row;
}

function createPreviewDefinition(rowState: ToolRowStateStore) {
	return defineTool<typeof contextPruneParameters, ContextPruneDetailsV1>({
		name: "context_prune",
		label: "context_prune",
		description: "Preview context pruning",
		parameters: contextPruneParameters,
		async execute() {
			return { content: [{ type: "text" as const, text: "" }], details: applied };
		},
		renderCall(args, theme, context): Component {
			return renderContextPruneCall(args, theme, {
				rowState,
				rowId: context.toolCallId,
				invalidate: context.invalidate,
				lastComponent: context.lastComponent,
			});
		},
		renderResult(result, options, theme, context): Component {
			return renderContextPruneResult(result, options.expanded, theme, context.lastComponent);
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
