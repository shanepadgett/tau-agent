import { createReadToolDefinition, type ReadToolInput } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { stripLeadingAt } from "./path-display.ts";

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;
type ReadExecute = ReadDefinition["execute"];
type ReadRenderCall = NonNullable<ReadDefinition["renderCall"]>;
type ReadRenderResult = NonNullable<ReadDefinition["renderResult"]>;

const readDefinitionByCwd = new Map<string, ReadDefinition>();

function readDefinitionForCwd(cwd: string): ReadDefinition {
	const existing = readDefinitionByCwd.get(cwd);
	if (existing) return existing;
	const definition = createReadToolDefinition(cwd);
	readDefinitionByCwd.set(cwd, definition);
	return definition;
}

function normalizeCountLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function normalizeReadParams(params: ReadToolInput): ReadToolInput {
	return {
		...params,
		path: stripLeadingAt(params.path),
		limit: params.limit === undefined ? undefined : normalizeCountLimit(params.limit, 1),
	};
}

function renderCallSummary(args: ReadToolInput | undefined): string {
	if (!args) return "";
	const path = stripLeadingAt(args.path);
	if (args.offset === undefined && args.limit === undefined) return path;
	const start = args.offset ?? 1;
	const limit = args.limit === undefined ? undefined : normalizeCountLimit(args.limit, 1);
	const end = limit === undefined ? "" : start + limit - 1;
	return `${path}:${start}${end === "" ? "" : `-${end}`}`;
}

export function createExploreReadTool(rowState: ToolRowStateStore): ReadDefinition {
	const baseDefinition = readDefinitionForCwd(process.cwd());
	return {
		...baseDefinition,
		async execute(
			toolCallId: Parameters<ReadExecute>[0],
			params: Parameters<ReadExecute>[1],
			signal: Parameters<ReadExecute>[2],
			onUpdate: Parameters<ReadExecute>[3],
			ctx: Parameters<ReadExecute>[4],
		) {
			const definition = readDefinitionForCwd(ctx.cwd);
			return definition.execute(toolCallId, normalizeReadParams(params), signal, onUpdate, ctx);
		},
		renderCall(
			args: Parameters<ReadRenderCall>[0],
			theme: Parameters<ReadRenderCall>[1],
			context: Parameters<ReadRenderCall>[2],
		) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "read", theme);
			text.setText(`${title} ${theme.fg("muted", renderCallSummary(args))}`);
			return text;
		},
		renderResult(
			result: Parameters<ReadRenderResult>[0],
			options: Parameters<ReadRenderResult>[1],
			theme: Parameters<ReadRenderResult>[2],
			context: Parameters<ReadRenderResult>[3],
		) {
			if (!context.expanded) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText("");
				return text;
			}
			const definition = readDefinitionForCwd(context.cwd);
			return definition.renderResult?.(result, { ...options, expanded: true }, theme, context) ?? new Text("", 0, 0);
		},
	};
}
