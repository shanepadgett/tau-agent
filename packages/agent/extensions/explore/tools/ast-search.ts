import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { BoundedTextResultBuilder } from "../../../shared/bounded-text-result.ts";
import type { TemporaryOutputStore } from "../../../shared/temporary-output-store.ts";
import type { ToolRowStateStore } from "../../../shared/tool-row-state.ts";
import type { ExploreEngine } from "../../../src/ast/engine.ts";
import {
	formatAstSearchEmpty,
	formatAstSearchFile,
	formatAstSearchFooters,
	groupAstSearchByFile,
} from "../../../src/ast/format/ast-search.ts";
import { astSearch } from "../../../src/ast/queries/ast-search.ts";
import { formatPathForDisplay, stripLeadingAt } from "../../../src/ast/traverse.ts";
import { ExploreCallComponent, renderExploreResult, type ExploreToolDetails } from "./render.ts";

const PATTERN_MAX_BYTES = 16 * 1024;

const astSearchParams = Type.Object(
	{
		path: Type.String({ description: "File or directory" }),
		pattern: Type.String({
			minLength: 1,
			maxLength: PATTERN_MAX_BYTES,
			description: "ast-grep pattern (max 16KiB). $NAME = node, $$$NAME = sequence, $_ = anonymous",
		}),
		language: Type.Optional(
			Type.String({
				description: "Registered id: typescript, tsx, go, rust, c_sharp, java, kotlin, swift",
			}),
		),
		resultLimit: Type.Integer({ minimum: 1, maximum: 100, description: "Max matches (1–100)" }),
	},
	{ additionalProperties: false },
);

type AstSearchParams = Static<typeof astSearchParams>;

type AstSearchExecuteResult = {
	content: Array<{ type: "text"; text: string }>;
	details: ExploreToolDetails;
};

function optionVariants(params: AstSearchParams): string[] {
	const lang = params.language !== undefined && params.language.length > 0 ? params.language : "lang?";
	const limit = params.resultLimit === undefined ? "limit" : `limit=${params.resultLimit}`;
	const pattern =
		params.pattern === undefined
			? "pattern"
			: params.pattern.length > 24
				? `${params.pattern.slice(0, 21)}...`
				: params.pattern;
	return [`[${lang} ${limit} ${pattern}]`];
}

export function createAstSearchTool(
	rowState: ToolRowStateStore,
	temporaryOutput: TemporaryOutputStore,
	engineFor: (cwd: string) => ExploreEngine,
) {
	return defineTool<typeof astSearchParams, ExploreToolDetails>({
		name: "ast_search",
		label: "ast_search",
		description:
			"ast-grep structural search on one file or a directory. $NAME = node, $$$NAME = sequence, $_ = anonymous. Directory targets require language. Search only.",
		promptSnippet: "ast-grep structural pattern search",
		promptGuidelines: [
			"Shapes here; literal text with harness grep.",
			"language required for directories; on a file, omit when extension maps the language.",
		],
		parameters: astSearchParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const engine = engineFor(ctx.cwd);
			const abort = signal ?? new AbortController().signal;
			const result = await astSearch(
				engine,
				params.path,
				params.pattern,
				params.language,
				params.resultLimit,
				abort,
			);

			const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
			try {
				const groups = groupAstSearchByFile(result.matches);
				for (const group of groups) {
					abort.throwIfAborted();
					await builder.appendBlock(
						group.path,
						formatPathForDisplay(group.path, engine.cwd),
						formatAstSearchFile(group.path, group.matches, engine.cwd),
					);
				}
				if (groups.length === 0) {
					await builder.appendBlock(undefined, "empty", formatAstSearchEmpty());
				}
				const footer = formatAstSearchFooters(result, engine.cwd);
				if (footer !== undefined) {
					abort.throwIfAborted();
					await builder.appendRequiredBlock("ast_search limits", footer);
				}
				const bounded = await builder.finish();
				return {
					content: [{ type: "text", text: bounded.content }],
					details: {
						declarationCount: result.matches.length,
						returnedBytes: Buffer.byteLength(bounded.content),
						truncated: bounded.overflow.truncated,
					},
				} satisfies AstSearchExecuteResult;
			} catch (error) {
				await builder.abort();
				throw error;
			}
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const targets = [stripLeadingAt(args.path ?? "")];
			const options = optionVariants(args);
			const component =
				(context.lastComponent as ExploreCallComponent | undefined) ??
				new ExploreCallComponent(rowState, context.toolCallId, "ast_search", targets, options, theme);
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
