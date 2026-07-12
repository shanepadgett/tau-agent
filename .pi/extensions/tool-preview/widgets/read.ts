import { defineTool, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolRowStateStore } from "../../../../packages/agent/shared/tool-row-state.ts";
import { formatToolRowTitle } from "../../../../packages/agent/shared/tool-row-state.ts";
import { addMessageBox, addPageTitle, addSampleTitle, addSection } from "./layout.ts";

interface ReadPreviewDetails {
	summary: string;
	tone: "normal" | "unchanged" | "diff" | "error";
	body: string;
}

interface ReadPreviewSpec {
	title: string;
	args: { path: string; offset?: number; limit?: number; lineNumbers?: boolean };
	argText: string;
	agentPayload: string;
	details?: ReadPreviewDetails;
	isError?: boolean;
}

const readPreviewParams = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
	lineNumbers: Type.Optional(Type.Boolean()),
});

const baselineBody = [
	'export const host = "127.0.0.1";',
	"export const port = 3000;",
	"export const retries = 3;",
].join("\n");

const diffBody = [
	"[read: 2 lines added, 1 removed of 84]",
	"--- a/src/config.ts",
	"+++ b/src/config.ts",
	"@@ -1,3 +1,4 @@",
	' export const host = "127.0.0.1";',
	"-export const port = 3000;",
	"+export const port = 4100;",
	"+export const requestTimeoutMs = 5000;",
	" export const retries = 3;",
].join("\n");

const readSpecs: readonly ReadPreviewSpec[] = [
	{
		title: "Pending Call",
		args: { path: "src/config.ts" },
		argText: "src/config.ts",
		agentPayload: "[No tool result yet.]",
	},
	{
		title: "Baseline Full Read",
		args: { path: "src/config.ts" },
		argText: "src/config.ts",
		agentPayload: baselineBody,
		details: { summary: "84 lines", tone: "normal", body: baselineBody },
	},
	{
		title: "Unchanged Full Read",
		args: { path: "src/config.ts" },
		argText: "src/config.ts",
		agentPayload: "unchanged, 84 lines",
		details: {
			summary: "unchanged, 84 lines",
			tone: "unchanged",
			body: "unchanged, 84 lines",
		},
	},
	{
		title: "Changed Full Read — Useful Diff",
		args: { path: "src/config.ts" },
		argText: "src/config.ts",
		agentPayload: diffBody,
		details: { summary: "+2 -1", tone: "diff", body: diffBody },
	},
	{
		title: "Changed Full Read — Baseline Fallback",
		args: { path: "src/config.ts" },
		argText: "src/config.ts",
		agentPayload: baselineBody,
		details: { summary: "84 lines", tone: "normal", body: baselineBody },
	},
	{
		title: "Unchanged Range — Whole File Unchanged",
		args: { path: "src/config.ts", offset: 20, limit: 12 },
		argText: "src/config.ts:20-31",
		agentPayload: "[read: unchanged, lines 20-31 of 84]",
		details: {
			summary: "unchanged",
			tone: "unchanged",
			body: "[read: unchanged, lines 20-31 of 84]",
		},
	},
	{
		title: "Changed Range — Content Returned",
		args: { path: "src/config.ts", offset: 20, limit: 12, lineNumbers: true },
		argText: "src/config.ts:20-31",
		agentPayload: [
			"20: export const connectTimeoutMs = 1000;",
			"21: export const requestTimeoutMs = 5000;",
			"22: export const retries = 3;",
			"",
			"[53 more lines in file. Use offset=32 to continue.]",
		].join("\n"),
		details: {
			summary: "12 lines",
			tone: "normal",
			body: [
				"20: export const connectTimeoutMs = 1000;",
				"21: export const requestTimeoutMs = 5000;",
				"22: export const retries = 3;",
				"",
				"[53 more lines in file. Use offset=32 to continue.]",
			].join("\n"),
		},
	},
	{
		title: "Read Error",
		args: { path: "src/missing.ts" },
		argText: "src/missing.ts",
		agentPayload: "Path not found: src/missing.ts",
		details: { summary: "error", tone: "error", body: "Path not found: src/missing.ts" },
		isError: true,
	},
];

export function createReadPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	const container = new Container();
	addPageTitle(container, theme, "Read Cache Row Preview");
	for (const spec of readSpecs) {
		addSampleTitle(container, theme, spec.title);
		addMessageBox(container, theme, "Agent Payload", spec.agentPayload);
		addSection(container, theme, "Collapsed Row", [createReadRow(tui, cwd, spec, false)]);
		addSection(container, theme, "Expanded Row", [createReadRow(tui, cwd, spec, true)]);
	}
	const prunedSpec = readSpecs[2];
	if (prunedSpec) {
		addSampleTitle(container, theme, "Pruned Unchanged Result");
		addSection(container, theme, "Collapsed", [createReadRow(tui, cwd, prunedSpec, false, true)]);
		addSection(container, theme, "Expanded", [createReadRow(tui, cwd, prunedSpec, true, true)]);
	}
	return container;
}

function createReadPreviewDefinition(warning: boolean) {
	const rowState = previewRowState(warning);
	return defineTool<typeof readPreviewParams, ReadPreviewDetails, unknown>({
		name: "read",
		label: "Read",
		description: "Preview proposed read cache rows",
		parameters: readPreviewParams,
		async execute() {
			return {
				content: [{ type: "text" as const, text: "" }],
				details: { summary: "", tone: "normal", body: "" },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (context.executionStarted) {
				text.setText("");
				return text;
			}
			text.setText(readHeader(theme, rowState, context.toolCallId, context.invalidate, formatArgs(args)));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details;
			if (!details) {
				text.setText("");
				return text;
			}
			const summary = renderSummary(details, theme);
			const header = `${readHeader(theme, rowState, context.toolCallId, context.invalidate, formatArgs(context.args))}  ${summary}`;
			text.setText(options.expanded ? `${header}\n${details.body}` : header);
			return text;
		},
	});
}

function createReadRow(
	tui: TUI,
	cwd: string,
	spec: ReadPreviewSpec,
	expanded: boolean,
	warning = false,
): ToolExecutionComponent {
	const row = new ToolExecutionComponent(
		"read",
		`read-${warning ? "warning-" : ""}${spec.title.toLowerCase().replaceAll(" ", "-")}-${expanded ? "expanded" : "collapsed"}`,
		spec.args,
		{},
		createReadPreviewDefinition(warning),
		tui,
		cwd,
	);
	if (spec.details) {
		row.markExecutionStarted();
		row.setArgsComplete();
		row.updateResult(
			{
				content: [{ type: "text", text: spec.agentPayload }],
				details: spec.details,
				isError: spec.isError ?? false,
			},
			false,
		);
	}
	row.setExpanded(expanded);
	return row;
}

function formatArgs(args: { path?: string; offset?: number; limit?: number }): string {
	const path = args.path ?? "";
	if (args.offset === undefined && args.limit === undefined) return path;
	const start = args.offset ?? 1;
	const end = args.limit === undefined ? "" : start + args.limit - 1;
	return `${path}:${start}${end === "" ? "" : `-${end}`}`;
}

function readHeader(
	theme: Theme,
	rowState: ToolRowStateStore,
	rowId: string,
	invalidate: () => void,
	args: string,
): string {
	rowState.watch(rowId, invalidate);
	return `${formatToolRowTitle(rowState, rowId, "read", theme)} ${theme.fg("muted", args)}`;
}

function renderSummary(details: ReadPreviewDetails, theme: Theme): string {
	if (details.tone === "unchanged") return theme.fg("success", details.summary);
	if (details.tone === "diff") return theme.fg("accent", details.summary);
	if (details.tone === "error") return theme.fg("error", details.summary);
	return theme.fg("muted", details.summary);
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
