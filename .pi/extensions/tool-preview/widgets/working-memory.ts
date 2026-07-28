import { defineTool, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";
import {
	workingMemoryParameters,
	type WorkingMemoryInput,
} from "../../../../packages/agent/extensions/working-memory/checkpoint.ts";
import {
	renderWorkingMemoryCall,
	renderWorkingMemoryResult,
} from "../../../../packages/agent/extensions/working-memory/render.ts";
import type { WorkingMemoryCheckpointDetailsV2 } from "../../../../packages/agent/extensions/working-memory/state.ts";
import type { ToolRowStateStore } from "../../../../packages/agent/shared/tool-row-state.ts";
import { addMessageBox, addPageTitle, addSampleTitle, addSection } from "./layout.ts";

const args: WorkingMemoryInput = {
	continuation:
		"Add readFiles to the checkpoint schema, publish the autoread request, then update state and renderer tests.",
	keep: ["m:user", "m:assistant"],
	readFiles: ["packages/agent/extensions/working-memory/settings.ts"],
	outlineFiles: ["packages/agent/extensions/working-memory/render.ts"],
	deferFiles: [
		{
			path: "packages/agent/extensions/working-memory/index.ts",
			reason: "registration wiring is not active",
			relevantWhen: "the checkpoint result needs delivery changes",
		},
	],
};

const details: WorkingMemoryCheckpointDetailsV2 = {
	v: 2,
	anchorToolCallId: "preview-working-memory",
	retainedRefs: ["m:user", "m:assistant"],
	retainedLabels: [
		{ ref: "m:user", label: "user", preview: "Carry a full-source autoread tier." },
		{ ref: "m:assistant", label: "assistant", preview: "Use Tau's autoread event." },
	],
	prunedRowIds: ["read-settings", "outline-render"],
	readFiles: args.readFiles,
	outlinedFiles: [{ path: "packages/agent/extensions/working-memory/render.ts", rowId: "preview-working-memory:0" }],
	deferredFiles: args.deferFiles,
	removedUnits: 6,
	warnings: [],
};

const result = [
	"## Continue",
	"",
	args.continuation,
	"",
	"## Deferred files",
	"",
	"- `packages/agent/extensions/working-memory/index.ts` — registration wiring is not active Reconsider when: the checkpoint result needs delivery changes.",
].join("\n");

const modelVisibleMessages = [
	"toolResult: working_memory",
	result,
	"",
	"custom: tau.autoread",
	"packages/agent/extensions/working-memory/settings.ts",
	'import { Type } from "typebox";',
	'import { defineTauExtensionSettings } from "../../shared/settings/define.ts";',
	"",
	"const DEFAULT_NUDGE_INSTRUCTIONS: [string, ...string[]] = [",
	'\t"Reassess working memory. Continue coherent exploration when its evidence remains useful; otherwise prune known dead ends, obsolete outputs, and other context with no expected value.",',
	'\t"Context is materially larger. Prune stale or bulky irrelevant evidence when safe, but keep active working evidence that would otherwise need to be reread.",',
	'\t"Strongly reassess before more broad work. Remove accumulated waste and carry useful information at cheapest sufficient fidelity without scrubbing the active working set.",',
	"];",
	"",
	"export default defineTauExtensionSettings({",
	'\tkey: "workingMemory",',
	"\tdefaults: {",
	"\t\tenabled: true as boolean,",
	"\t\tnudgeEveryTokens: 40_000 as number,",
	"\t\tnudgeInstructions: DEFAULT_NUDGE_INSTRUCTIONS,",
	"\t},",
	"\tschema: Type.Object(",
	"\t\t{",
	'\t\t\tenabled: Type.Optional(Type.Boolean({ default: true, description: "Enable working-memory checkpoints." })),',
	"\t\t\tnudgeEveryTokens: Type.Optional(",
	"\t\t\t\tType.Integer({",
	"\t\t\t\t\tdefault: 40_000,",
	"\t\t\t\t\tminimum: 1,",
	'\t\t\t\t\tdescription: "Active-context token interval between advisory working-memory reminders.",',
	"\t\t\t\t}),",
	"\t\t\t),",
	"\t\t\tnudgeInstructions: Type.Optional(",
	"\t\t\t\tType.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {",
	"\t\t\t\t\tdefault: DEFAULT_NUDGE_INSTRUCTIONS,",
	"\t\t\t\t\tminItems: 1,",
	"\t\t\t\t\tmaxItems: 5,",
	'\t\t\t\t\tdescription: "Ordered advisory working-memory instructions. Later reminders repeat final instruction.",',
	"\t\t\t\t}),",
	"\t\t\t),",
	"\t\t},",
	"\t\t{ additionalProperties: false },",
	"\t),",
	"});",
	"",
	"custom: tau.explore.outline",
	"packages/agent/extensions/working-memory/render.ts",
	"L94-119: export function renderWorkingMemoryCall(...)\nL121-152: export function renderWorkingMemoryResult(...)",
].join("\n");

export function createWorkingMemoryPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	const container = new Container();
	addPageTitle(container, theme, "Working Memory Row Preview");
	addSampleTitle(container, theme, "Read, Outline, and Deferred Tiers");
	addMessageBox(container, theme, "Model-visible Messages", modelVisibleMessages);
	addSection(container, theme, "Initial Call", [createToolRow(tui, cwd, "pending", false)]);
	addSection(container, theme, "Collapsed Result", [createToolRow(tui, cwd, "collapsed", false)]);
	addSection(container, theme, "Expanded Result", [createToolRow(tui, cwd, "expanded", false)]);
	addSampleTitle(container, theme, "Pruned Result");
	addSection(container, theme, "Collapsed", [createToolRow(tui, cwd, "collapsed", true)]);
	addSection(container, theme, "Expanded", [createToolRow(tui, cwd, "expanded", true)]);
	return container;
}

function createToolRow(
	tui: TUI,
	cwd: string,
	state: "pending" | "collapsed" | "expanded",
	pruned: boolean,
): ToolExecutionComponent {
	const row = new ToolExecutionComponent(
		"working_memory",
		`working-memory-${pruned ? "pruned" : "normal"}-${state}`,
		args,
		{},
		createDefinition(pruned),
		tui,
		cwd,
	);
	row.setArgsComplete();
	if (state === "pending") return row;
	row.markExecutionStarted();
	row.updateResult({ content: [{ type: "text", text: result }], details, isError: false }, false);
	row.setExpanded(state === "expanded");
	return row;
}

function createDefinition(pruned: boolean) {
	const rowState = previewRowState(pruned);
	return defineTool<typeof workingMemoryParameters, WorkingMemoryCheckpointDetailsV2>({
		name: "working_memory",
		label: "working_memory",
		description: "Preview working-memory tool row",
		parameters: workingMemoryParameters,
		async execute() {
			return { content: [{ type: "text" as const, text: result }], details };
		},
		renderCall(callArgs, theme, context) {
			return renderWorkingMemoryCall(callArgs, theme, {
				rowState,
				rowId: context.toolCallId,
				invalidate: context.invalidate,
				lastComponent: context.lastComponent,
				executionStarted: context.executionStarted,
			});
		},
		renderResult(toolResult, options, theme, context) {
			return renderWorkingMemoryResult(toolResult, options.expanded, theme, context.lastComponent);
		},
	});
}

function previewRowState(pruned: boolean): ToolRowStateStore {
	return {
		get() {
			return pruned ? "pruned" : undefined;
		},
		watch() {},
		clear() {},
	};
}
