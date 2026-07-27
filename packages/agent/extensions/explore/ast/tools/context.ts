import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BoundedTextResultBuilder } from "../../../../shared/bounded-text-result.ts";
import { loadTauExtensionSettings } from "../../../../shared/settings/load.ts";
import type { TemporaryOutputStore } from "../../../../shared/temporary-output-store.ts";
import type { ToolRowStateStore } from "../../../../shared/tool-row-state.ts";
import exploreSettings from "../../settings.ts";
import type { ExploreEngine } from "../engine.ts";
import { contextSectionBlocks, formatContextResult } from "../format/context.ts";
import type { ExploreFileGraph } from "../graph/file-graph.ts";
import { queryContext } from "../queries/context.ts";
import { stripLeadingAt } from "../../traverse.ts";
import { ExploreCallComponent, renderExploreResult, type ExploreToolDetails } from "./render.ts";

const contextParams = Type.Object(
	{
		path: Type.String({ description: "Directory scope (repo/package/subtree)" }),
		targetPath: Type.Optional(Type.String({ description: "Defining file when known" })),
		name: Type.String({ minLength: 1, description: "Declaration name; may be dotted (Type.method)" }),
		line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line to pin one candidate" })),
		budget: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Token pack budget (default from explore.context.defaultBudgetTokens)",
			}),
		),
	},
	{ additionalProperties: false },
);

export function createContextTool(
	rowState: ToolRowStateStore,
	temporaryOutput: TemporaryOutputStore,
	engineFor: (cwd: string) => ExploreEngine,
	graphFor: (cwd: string) => ExploreFileGraph,
) {
	return defineTool<typeof contextParams, ExploreToolDetails>({
		name: "context",
		label: "context",
		description:
			"Budgeted pack to understand one symbol in one call: target body, nearby callees/callers or type members/implementors. Raise budget if truncated. Use impact for full blast radius.",
		promptSnippet: "Budgeted read pack for one symbol",
		promptGuidelines: [
			"Use when you need bodies/signatures around one symbol under a token budget.",
			"Raise budget if entries are signature-only or truncated.",
			"Use impact for full dependents list; context is a sample pack.",
			"Callable and type targets only.",
		],
		parameters: contextParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const engine = engineFor(ctx.cwd);
			const graph = graphFor(ctx.cwd);
			const abort = signal ?? new AbortController().signal;
			const settings = await loadTauExtensionSettings(ctx, exploreSettings);
			const budget = params.budget ?? settings.context.defaultBudgetTokens;
			const result = await queryContext({
				engine,
				graph,
				scopePath: params.path,
				targetPath: params.targetPath,
				name: params.name,
				line: params.line,
				budget,
				signal: abort,
			});

			if (result.kind !== "resolved") {
				const text = formatContextResult(result, engine.cwd);
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
				const blocks = contextSectionBlocks(result, engine.cwd);
				for (const block of blocks) {
					abort.throwIfAborted();
					if (block.id === "footer") {
						await builder.appendRequiredBlock(block.label, block.text);
					} else {
						await builder.appendBlock(block.id, block.label, block.text);
					}
				}
				const bounded = await builder.finish();
				const declarationCount = result.groups.reduce((sum, group) => sum + group.entries.length, 0);
				return {
					content: [{ type: "text", text: bounded.content }],
					details: {
						declarationCount,
						returnedBytes: Buffer.byteLength(bounded.content),
						truncated: bounded.overflow.truncated || result.truncated,
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
			const budget = args.budget === undefined ? "budget=default" : `budget=${args.budget}`;
			const options = [`[scope=${scope} ${budget}]`];
			const component =
				(context.lastComponent as ExploreCallComponent | undefined) ??
				new ExploreCallComponent(rowState, context.toolCallId, "context", targets, options, theme);
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
