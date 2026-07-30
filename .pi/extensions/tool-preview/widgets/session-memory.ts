import { defineTool, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import {
	renderSessionMemoryCall,
	renderSessionMemoryResult,
} from "../../../../packages/agent/extensions/session-memory/render.ts";
import {
	formatSessionMemory,
	sessionMemoryParameters,
	type SessionMemoryDetailsV2,
	type SessionMemoryInput,
} from "../../../../packages/agent/extensions/session-memory/state.ts";
import {
	createSessionMemoryWidget,
	type SessionMemoryTab,
	type SessionMemoryWidgetView,
} from "../../../../packages/agent/extensions/session-memory/widget.ts";
import type { ToolRowStateStore } from "../../../../packages/agent/shared/tool-row-state.ts";
import { addMessageBox, addPageTitle, addSampleTitle, addSection } from "./layout.ts";

const VIEW: SessionMemoryWidgetView = {
	longTermGoal: "Ship bounded session memory without losing intent or expensive findings.",
	checkpoint: 4,
	activeTokens: 62_000,
	updatedAt: Date.now(),
	tasks: [
		"Build canonical state and checkpoint transitions",
		"Wire required-gate projection",
		"Cut over session-memory surfaces",
	],
	shortTermMemories: [
		{
			id: "required-gate",
			text: "Required checkpoints block execution while tool definitions stay stable.",
			bornAtCheckpoint: 4,
		},
		{ id: "short-term-span", text: "New findings get one complete checkpoint span.", bornAtCheckpoint: 4 },
	],
	longTermMemories: [
		{ id: "goal-direction", text: "Long-term goals change when durable direction changes." },
		{ id: "cache-stability", text: "Cache stability is a correctness requirement." },
	],
	readFiles: ["packages/agent/extensions/session-memory/index.ts", "packages/agent/extensions/session-memory/tool.ts"],
	outlineFiles: ["packages/agent/extensions/session-memory/projection.ts"],
	deferFiles: [
		{
			path: "packages/agent/extensions/session-memory/widget.ts",
			reason: "renderer is complete",
			relevantWhen: "visual tests fail",
		},
	],
};

const UPDATE_ARGS: Extract<SessionMemoryInput, { action: "update" }> = {
	action: "update",
	longTermGoal: "Plan direct Initiative-to-Source associations.",
	tasks: ["Update the schema and API.", "Wire context and UI changes."],
	shortTermMemories: [{ id: "association-shape", text: "Initiatives point directly to source records." }],
	longTermMemories: [
		{ id: "schema-boundary", text: "Keep relationship validation at the schema boundary." },
		{ id: "ui-labels", text: "Use source names consistently in user-facing labels." },
	],
	readFiles: ["docs/VOCABULARY.md", "packages/agent/extensions/session-memory/state.ts"],
	outlineFiles: ["packages/agent/extensions/session-memory"],
	deferFiles: [],
};

const SUCCESS_DETAILS: SessionMemoryDetailsV2 = {
	v: 2,
	toolCallId: "session-memory-success",
	kind: "update",
	checkpoint: 4,
	state: {
		longTermGoal: UPDATE_ARGS.action === "update" ? UPDATE_ARGS.longTermGoal : null,
		tasks: UPDATE_ARGS.action === "update" ? UPDATE_ARGS.tasks : [],
		shortTermMemories: UPDATE_ARGS.shortTermMemories.map((item) => ({ ...item, bornAtCheckpoint: 4 })),
		longTermMemories: UPDATE_ARGS.action === "update" ? UPDATE_ARGS.longTermMemories : [],
		readFiles: UPDATE_ARGS.action === "update" ? UPDATE_ARGS.readFiles : [],
		outlineFiles: UPDATE_ARGS.action === "update" ? UPDATE_ARGS.outlineFiles : [],
		deferFiles: UPDATE_ARGS.action === "update" ? UPDATE_ARGS.deferFiles : [],
	},
	changes: ["Long-term goal updated", "2 new tasks", "2 tasks closed", "2 memories promoted", "1 file added"],
	outlinedRows: [],
	prunedRowIds: [],
	warnings: [],
};

const ERROR_ARGS = {
	...UPDATE_ARGS,
	readFiles: Array.from({ length: 13 }, (_, index) => `docs/reference-${index + 1}.md`),
};

const VALIDATION_ERROR = [
	'Validation failed for tool "session_memory":',
	"  - readFiles: must not have more than 12 items",
	"  - root: must not have additional properties",
	"  - action: must be equal to constant",
	"  - root: must match a schema in anyOf",
	"",
	"Received arguments:",
	JSON.stringify(ERROR_ARGS, null, 2),
].join("\n");

export function createSessionMemoryToolPreviewWidget(tui: TUI, cwd: string, theme: Theme): Component {
	const container = new Container();
	addPageTitle(container, theme, "Session Memory Row Preview");
	const successText = formatSessionMemory(SUCCESS_DETAILS.state, SUCCESS_DETAILS.checkpoint, []);
	for (const spec of [
		{
			title: "Successful Update",
			args: UPDATE_ARGS,
			result: successText,
			details: SUCCESS_DETAILS,
			isError: false,
		},
		{
			title: "Schema Validation Error",
			args: ERROR_ARGS,
			result: VALIDATION_ERROR,
			details: undefined,
			isError: true,
		},
	] as const) {
		addSampleTitle(container, theme, spec.title);
		addMessageBox(container, theme, "Agent Payload", spec.result);
		addSection(container, theme, "Initial Call", [createSessionMemoryToolRow(tui, cwd, spec, "pending")]);
		addSection(container, theme, "Collapsed Result", [createSessionMemoryToolRow(tui, cwd, spec, "collapsed")]);
		addSection(container, theme, "Expanded Result", [createSessionMemoryToolRow(tui, cwd, spec, "expanded")]);
	}
	return container;
}

function createSessionMemoryToolRow(
	tui: TUI,
	cwd: string,
	spec: {
		readonly title: string;
		readonly args: SessionMemoryInput;
		readonly result: string;
		readonly details: SessionMemoryDetailsV2 | undefined;
		readonly isError: boolean;
	},
	state: "pending" | "collapsed" | "expanded",
): ToolExecutionComponent {
	const rowState: ToolRowStateStore = {
		get() {
			return undefined;
		},
		watch() {},
		clear() {},
	};
	const definition = defineTool<typeof sessionMemoryParameters, SessionMemoryDetailsV2>({
		name: "session_memory",
		label: "session_memory",
		renderShell: "self",
		description: "Preview session-memory tool row",
		parameters: sessionMemoryParameters,
		async execute() {
			throw new Error("Preview only");
		},
		renderCall(args, theme, context) {
			return renderSessionMemoryCall(args, theme, {
				visible: true,
				rowState,
				rowId: context.toolCallId,
				invalidate: context.invalidate,
				lastComponent: context.lastComponent,
			});
		},
		renderResult(result, _options, theme, context) {
			return renderSessionMemoryResult(result, true, theme, context.lastComponent);
		},
	});
	const row = new ToolExecutionComponent(
		"session_memory",
		`session-memory-${spec.isError ? "error" : "success"}-${state}`,
		spec.args,
		{},
		definition,
		tui,
		cwd,
	);
	row.setArgsComplete();
	if (state === "pending") return row;
	row.markExecutionStarted();
	row.updateResult(
		{ content: [{ type: "text", text: spec.result }], details: spec.details, isError: spec.isError },
		false,
	);
	row.setExpanded(state === "expanded");
	return row;
}

export function createSessionMemoryPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Component {
	return new SessionMemoryPreview(_tui, theme);
}

class SessionMemoryPreview implements Component {
	private readonly widgets: readonly Component[];

	constructor(tui: TUI, theme: Theme) {
		this.widgets = (["tasks", "memories", "files"] as const satisfies readonly SessionMemoryTab[]).map(
			(selectedTab) =>
				createSessionMemoryWidget(tui, theme, getKeybindings(), { view: VIEW, selectedTab, onClose: () => {} }),
		);
	}

	render(width: number): string[] {
		return this.widgets.flatMap((widget, index) =>
			index === 0 ? widget.render(width) : ["", ...widget.render(width)],
		);
	}

	invalidate(): void {
		for (const widget of this.widgets) widget.invalidate();
	}
}
