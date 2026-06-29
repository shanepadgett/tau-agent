import { defineTool, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath, stripLeadingAt } from "./path-display.ts";
import { type PathTreeEntry, renderPathTree } from "./path-tree.ts";
import { createExploreTextResult, type ExploreTextDetails, expandedExploreText } from "./result.ts";
import { collectPaths, type TraversalEntry } from "./traverse.ts";

const lsParams = Type.Object(
	{
		paths: Type.Optional(Type.Array(Type.String())),
		depth: Type.Optional(Type.Number()),
		limit: Type.Optional(Type.Number()),
		all: Type.Optional(Type.Boolean()),
		long: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

type LsParams = Static<typeof lsParams>;

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function normalizeCountLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function divideBudget(limit: number, count: number): number[] {
	if (count <= 0) return [];
	const base = Math.max(1, Math.floor(limit / count));
	let remainder = Math.max(0, limit - base * count);
	return Array.from({ length: count }, () => {
		const extra = remainder > 0 ? 1 : 0;
		if (remainder > 0) remainder -= 1;
		return base + extra;
	});
}

function formatTime(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function entryMetadata(entry: TraversalEntry, long: boolean): string | undefined {
	if (!long) return undefined;
	const size = entry.type === "dir" ? "dir" : formatSize(entry.stats.size);
	return `${size} ${formatTime(entry.stats.mtime)}`;
}

function pathTreeEntry(entry: TraversalEntry, long: boolean): PathTreeEntry {
	return {
		displayPath: entry.displayPath,
		type: entry.type,
		metadata: entryMetadata(entry, long),
		empty: entry.empty,
	};
}

function renderCallSummary(args: LsParams | undefined): string {
	const paths = args?.paths && args.paths.length > 0 ? args.paths.map(stripLeadingAt).join(" ") : ".";
	const depth = normalizeNonNegativeInteger(args?.depth, 1);
	const limit = normalizeCountLimit(args?.limit, 100);
	const flags = [args?.all ? "all" : "", args?.long ? "long" : ""].filter(Boolean).join(" ");
	return `paths=${paths} depth=${depth} limit=${limit}${flags ? ` ${flags}` : ""}`;
}

export function createLsTool(rowState: ToolRowStateStore) {
	return defineTool<typeof lsParams, ExploreTextDetails | undefined>({
		name: "ls",
		label: "ls",
		description: "List files and directories with compact path output.",
		promptSnippet: "List files and directories",
		parameters: lsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requestedPaths = params.paths && params.paths.length > 0 ? params.paths : ["."];
			const depth = normalizeNonNegativeInteger(params.depth, 1);
			const limit = normalizeCountLimit(params.limit, 100);
			const budgets = divideBudget(limit, requestedPaths.length);
			const all = params.all === true;
			const humanParts: string[] = [];
			const agentParts: string[] = [];

			for (let i = 0; i < requestedPaths.length; i += 1) {
				const input = requestedPaths[i] ?? ".";
				const root = resolveExplorePath(ctx.cwd, input);
				const entries = await collectPaths({
					cwd: ctx.cwd,
					root,
					maxDepth: depth,
					includeRoot: true,
					includeHidden: all,
					includeIgnored: all,
					includeNoise: all,
				}).catch((error: unknown) => {
					throw pathResolutionError(error, input);
				});

				const budget = budgets[i] ?? limit;
				const shown = entries.slice(0, budget);
				const omitted = entries.length - shown.length;
				const notice = omitted > 0 ? `… omitted ${omitted} entries (limit ${budget})` : undefined;
				const rootPath = formatPathForDisplay(root, ctx.cwd);
				const tree = renderPathTree(
					shown.map((entry) => pathTreeEntry(entry, params.long === true)),
					{
						rootPath,
						omissionNotice: notice,
					},
				);
				humanParts.push(tree.humanText);
				agentParts.push(tree.agentText);
			}

			return createExploreTextResult(agentParts.join("\n\n"), humanParts.join("\n\n"));
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "ls", theme);
			text.setText(`${title} ${theme.fg("muted", renderCallSummary(args))}`);
			return text;
		},
		renderResult(result, _options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(context.expanded ? expandedExploreText(result) : "");
			return text;
		},
	});
}
