import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BoundedTextResultBuilder } from "../../../../shared/bounded-text-result.ts";
import type { TemporaryOutputStore } from "../../../../shared/temporary-output-store.ts";
import type { ToolRowStateStore } from "../../../../shared/tool-row-state.ts";
import type { ExploreEngine } from "../engine.ts";
import { formatImpactResult, impactSectionBlocks } from "../format/impact.ts";
import type { ExploreFileGraph } from "../graph/file-graph.ts";
import { IMPACT_DEPTH_DEFAULT, IMPACT_DEPTH_MAX, queryImpact, type ImpactMode } from "../queries/impact.ts";
import { stripLeadingAt } from "../../traverse.ts";
import { ExploreCallComponent, renderExploreResult, type ExploreToolDetails } from "./render.ts";

const impactParams = Type.Object(
	{
		path: Type.String({ description: "Directory scope (repo/package/subtree)" }),
		targetPath: Type.Optional(Type.String({ description: "Defining file when known" })),
		name: Type.String({ minLength: 1, description: "Declaration name; may be dotted (Type.method)" }),
		line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line to pin one candidate" })),
		depth: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: IMPACT_DEPTH_MAX,
				description: `File-transitive reverse depth (default ${IMPACT_DEPTH_DEFAULT}, max ${IMPACT_DEPTH_MAX}). Symbol hops are always 1.`,
			}),
		),
		mode: Type.Optional(
			StringEnum(["all", "deps", "dependents"] as const, {
				description: "all = both sides; deps = callees+imports; dependents = callers+importers+transitive",
			}),
		),
	},
	{ additionalProperties: false },
);

export function createImpactTool(
	rowState: ToolRowStateStore,
	temporaryOutput: TemporaryOutputStore,
	engineFor: (cwd: string) => ExploreEngine,
	graphFor: (cwd: string) => ExploreFileGraph,
) {
	return defineTool<typeof impactParams, ExploreToolDetails>({
		name: "impact",
		label: "impact",
		description:
			"One-call blast radius for a symbol: callees, callers, file imports, file importers, transitive file dependents. Narrow path scope. depth is file-transitive only.",
		promptSnippet: "Blast radius before a non-trivial edit",
		promptGuidelines: [
			"Use before a non-trivial edit to see symbol and nearby file dependents.",
			"Narrow path scope — whole-repo impact is not the goal.",
			"depth applies only to reverse file dependents (not multi-hop symbol callers).",
			"mode=deps for outbound only; mode=dependents for inbound only.",
			"Callable and type targets only.",
		],
		parameters: impactParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const engine = engineFor(ctx.cwd);
			const graph = graphFor(ctx.cwd);
			const abort = signal ?? new AbortController().signal;
			const depth = params.depth ?? IMPACT_DEPTH_DEFAULT;
			const mode = (params.mode ?? "all") as ImpactMode;
			const result = await queryImpact({
				engine,
				graph,
				scopePath: params.path,
				targetPath: params.targetPath,
				name: params.name,
				line: params.line,
				depth,
				mode,
				signal: abort,
			});

			if (result.kind !== "resolved") {
				const text = formatImpactResult(result, engine.cwd);
				return {
					content: [{ type: "text", text }],
					details: {
						declarationCount: 0,
						returnedBytes: Buffer.byteLength(text),
						truncated: false,
					},
				};
			}

			const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
			try {
				const blocks = impactSectionBlocks(result, engine.cwd);
				let count = 0;
				for (const block of blocks) {
					abort.throwIfAborted();
					if (block.id === "footer") {
						await builder.appendRequiredBlock(block.label, block.text);
					} else {
						await builder.appendBlock(block.id, block.label, block.text);
					}
					count += 1;
				}
				const bounded = await builder.finish();
				return {
					content: [{ type: "text", text: bounded.content }],
					details: {
						declarationCount: count,
						returnedBytes: Buffer.byteLength(bounded.content),
						truncated: bounded.overflow.truncated,
					},
				};
			} catch (error) {
				await builder.abort();
				throw error;
			}
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const name = args.name ?? "?";
			const scope = stripLeadingAt(args.path ?? "");
			const pin = args.targetPath !== undefined ? stripLeadingAt(args.targetPath) : "";
			const targets = pin.length > 0 ? [`${name} @ ${pin}`] : [name];
			const depth = args.depth ?? IMPACT_DEPTH_DEFAULT;
			const mode = args.mode ?? "all";
			const options = [`[scope=${scope} depth=${depth} mode=${mode}]`];
			const component =
				(context.lastComponent as ExploreCallComponent | undefined) ??
				new ExploreCallComponent(rowState, context.toolCallId, "impact", targets, options, theme);
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
