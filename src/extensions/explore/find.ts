import { lstat } from "node:fs/promises";
import { basename, matchesGlob } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import {
	formatPathForDisplay,
	pathResolutionError,
	relativeSlash,
	resolveExplorePath,
	stripLeadingAt,
	toSlashPath,
} from "./path-display.ts";
import { type PathTreeEntry, renderPathTree } from "./path-tree.ts";
import { createExploreTextResult, type ExploreTextDetails, expandedExploreText } from "./result.ts";
import { collectPaths, type TraversalEntry } from "./traverse.ts";

const findQueryParams = Type.Object(
	{
		path: Type.Optional(Type.String()),
		patterns: Type.Optional(Type.Array(Type.String())),
		type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("dir"), Type.Literal("any")])),
		maxDepth: Type.Optional(Type.Number()),
		hidden: Type.Optional(Type.Boolean()),
		noIgnore: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const findParams = Type.Object(
	{
		queries: Type.Array(findQueryParams, { minItems: 1 }),
		limit: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

type FindParams = Static<typeof findParams>;
type FindQuery = Static<typeof findQueryParams>;

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

function globMatches(pattern: string, value: string): boolean {
	const normalizedValue = toSlashPath(value);
	const normalizedPattern = toSlashPath(pattern);
	return (
		matchesGlob(normalizedValue, normalizedPattern) ||
		(normalizedValue.startsWith(".") && matchesGlob(normalizedValue.slice(1), normalizedPattern))
	);
}

function queryMatches(entry: TraversalEntry, queryRoot: string, query: FindQuery): boolean {
	const type = query.type ?? "any";
	if (type !== "any" && entry.type !== type) return false;
	const patterns = query.patterns?.map(stripLeadingAt).filter((pattern) => pattern.length > 0) ?? [];
	if (patterns.length === 0) return true;
	const rel = relativeSlash(queryRoot, entry.absolutePath);
	return patterns.some((pattern) => globMatches(pattern, pattern.includes("/") ? rel : basename(entry.displayPath)));
}

function toTreeEntry(entry: TraversalEntry): PathTreeEntry {
	return { displayPath: entry.displayPath, type: entry.type };
}

function renderCallSummary(args: FindParams | undefined): string {
	const queries = args?.queries ?? [];
	const limit = normalizeCountLimit(args?.limit, 100);
	if (queries.length !== 1) return `${queries.length} queries limit=${limit}`;
	const query = queries[0];
	const path = stripLeadingAt(query?.path ?? ".");
	const patterns = query?.patterns?.map(stripLeadingAt).join(",") || "*";
	const type = query?.type ?? "any";
	const depth = query?.maxDepth === undefined ? "∞" : String(normalizeNonNegativeInteger(query.maxDepth, 0));
	const flags = [query?.hidden ? "hidden" : "", query?.noIgnore ? "noIgnore" : ""].filter(Boolean).join(" ");
	return `path=${path} patterns=${patterns} type=${type} depth=${depth} limit=${limit}${flags ? ` ${flags}` : ""}`;
}

export function createFindTool(rowState: ToolRowStateStore) {
	return defineTool<typeof findParams, ExploreTextDetails | undefined>({
		name: "find",
		label: "find",
		description: "Find files and directories by structured path queries.",
		promptSnippet: "Find files and directories",
		parameters: findParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.queries.length === 0) throw new Error("find requires at least one query");
			const limit = normalizeCountLimit(params.limit, 100);
			const budgets = divideBudget(limit, params.queries.length);
			const humanParts: string[] = [];
			const agentParts: string[] = [];

			for (let i = 0; i < params.queries.length; i += 1) {
				const query = params.queries[i];
				if (!query) continue;
				const inputPath = query.path ?? ".";
				const root = resolveExplorePath(ctx.cwd, inputPath);
				const rootStats = await lstat(root).catch((error: unknown) => {
					throw pathResolutionError(error, inputPath);
				});
				const entries = await collectPaths({
					cwd: ctx.cwd,
					root,
					maxDepth: query.maxDepth === undefined ? undefined : normalizeNonNegativeInteger(query.maxDepth, 0),
					includeRoot: rootStats.isFile(),
					includeHidden: query.hidden === true,
					includeIgnored: query.noIgnore === true,
					includeNoise: query.noIgnore === true,
				}).catch((error: unknown) => {
					throw new Error(`Query ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
				});
				const matches = entries.filter((entry) => queryMatches(entry, root, query));
				const budget = budgets[i] ?? limit;
				const shown = matches.slice(0, budget);
				const omitted = matches.length - shown.length;
				const notice = omitted > 0 ? `… omitted ${omitted} matches (limit ${budget})` : undefined;
				const rootPath = formatPathForDisplay(root, ctx.cwd);
				const tree =
					shown.length > 0
						? renderPathTree(shown.map(toTreeEntry), { rootPath, omissionNotice: notice })
						: undefined;
				const humanText = tree?.humanText ?? "No matches";
				const agentText = tree?.agentText ?? "No matches";
				if (params.queries.length === 1) {
					humanParts.push(humanText);
					agentParts.push(agentText);
				} else {
					humanParts.push(`query ${i + 1}\n${humanText}`);
					agentParts.push(`q${i + 1}\n${agentText}`);
				}
			}

			return createExploreTextResult(agentParts.join("\n"), humanParts.join("\n"));
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "find", theme);
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
