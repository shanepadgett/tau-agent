import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateBoundedHead } from "../../../shared/bounded-text-result.ts";
import type { ToolRowStateStore } from "../../../shared/tool-row-state.ts";
import type { ExploreEngine } from "../../../src/ast/engine.ts";
import { formatDepsEmpty, formatDepsResult } from "../../../src/ast/format/deps.ts";
import type { ExploreFileGraph } from "../../../src/ast/graph/file-graph.ts";
import { stripLeadingAt } from "../../../src/ast/traverse.ts";
import { ExploreCallComponent, renderExploreResult, type ExploreToolDetails } from "./render.ts";

const depsParams = Type.Object(
	{
		path: Type.String({ description: "Source file" }),
		depth: Type.Optional(Type.Integer({ minimum: 1, description: "Traversal depth (default 1)" })),
		resultLimit: Type.Integer({ minimum: 1, maximum: 100, description: "Max dependent entries to return" }),
	},
	{ additionalProperties: false },
);

export function createDepsTool(
	rowState: ToolRowStateStore,
	engineFor: (cwd: string) => ExploreEngine,
	graphFor: (cwd: string) => ExploreFileGraph,
) {
	return defineTool<typeof depsParams, ExploreToolDetails>({
		name: "deps",
		label: "deps",
		description:
			"File-level: what this file imports/depends on. Depth > 1 walks the internal import graph (BFS). External packages are listed last.",
		promptSnippet: "List file imports and dependencies",
		promptGuidelines: [
			"Use for file-level dependency orientation, not symbol callees.",
			"Increase depth only when transitive internal imports matter.",
			"Tighten resultLimit when output is large.",
		],
		parameters: depsParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const engine = engineFor(ctx.cwd);
			const graph = graphFor(ctx.cwd);
			const abort = signal ?? new AbortController().signal;
			const depth = params.depth ?? 1;
			const result = await graph.deps(params.path, depth, params.resultLimit, abort);
			const text = formatDepsResult(result, engine.cwd, formatDepsEmpty());
			const bounded = truncateBoundedHead(text);
			return {
				content: [{ type: "text", text: bounded.content }],
				details: {
					declarationCount: result.hits.length,
					returnedBytes: Buffer.byteLength(bounded.content),
					truncated: bounded.truncated,
				},
			};
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const targets = [stripLeadingAt(args.path ?? "")];
			const depth = args.depth ?? 1;
			const options = [`[depth=${depth} limit=${args.resultLimit ?? "?"}]`];
			const component =
				(context.lastComponent as ExploreCallComponent | undefined) ??
				new ExploreCallComponent(rowState, context.toolCallId, "deps", targets, options, theme);
			component.targetVariants = targets;
			component.optionVariants = options;
			component.theme = theme;
			return component;
		},
		renderResult(result, options, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			return renderExploreResult(result, options.expanded, theme, context);
		},
	});
}
