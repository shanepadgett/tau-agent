import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { BoundedTextResultBuilder } from "../../../../shared/bounded-text-result.ts";
import type { TemporaryOutputStore } from "../../../../shared/temporary-output-store.ts";
import type { ToolRowStateStore } from "../../../../shared/tool-row-state.ts";
import type { DeclKind } from "../ir.ts";
import {
	formatDiscoverEmpty,
	formatDiscoverFile,
	formatDiscoverFooters,
	groupDiscoverByFile,
} from "../format/discover.ts";
import { discover, type DiscoverQuery, type DiscoverSurface } from "../queries/discover.ts";
import type { ExploreEngine } from "../engine.ts";
import { formatPathForDisplay, stripLeadingAt } from "../../traverse.ts";
import { ExploreCallComponent, renderExploreResult, shrinkingListVariants, type ExploreToolDetails } from "./render.ts";

const declarationKinds = [
	"module",
	"namespace",
	"package",
	"class",
	"method",
	"property",
	"field",
	"constructor",
	"enum",
	"interface",
	"typeAlias",
	"function",
	"variable",
	"constant",
	"object",
	"enumMember",
	"struct",
	"event",
	"operator",
	"typeParameter",
	"heading",
] as const satisfies readonly DeclKind[];

const discoverParams = Type.Object(
	{
		path: Type.String({ description: "Repository, package, or subtree directory" }),
		query: Type.Union([
			Type.Object(
				{ kind: Type.Literal("exactName"), name: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			Type.Object(
				{ kind: Type.Literal("prefixName"), name: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			Type.Object(
				{ kind: Type.Literal("substringName"), name: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("fuzzyName"),
					name: Type.String({ minLength: 1 }),
					maxCandidates: Type.Integer({ minimum: 1, maximum: 10_000 }),
					maxWork: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("declarationKind"),
					declarationKind: StringEnum(declarationKinds),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("documentation"),
					terms: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
					maxCandidates: Type.Integer({ minimum: 1, maximum: 10_000 }),
					maxWork: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
				},
				{ additionalProperties: false },
			),
		]),
		surface: StringEnum(["all", "public", "private", "sourceExport", "packageSurface"] as const, {
			description: "Declaration or export surface to search",
		}),
		resultLimit: Type.Integer({ minimum: 1, maximum: 100 }),
	},
	{ additionalProperties: false },
);

type DiscoverParams = Static<typeof discoverParams>;

type DiscoverExecuteResult = {
	content: Array<{ type: "text"; text: string }>;
	details: ExploreToolDetails;
};

function formatQueryLabel(query: DiscoverParams["query"]): string {
	switch (query.kind) {
		case "exactName":
		case "prefixName":
		case "substringName":
		case "fuzzyName":
			return `${query.kind}=${query.name}`;
		case "declarationKind":
			return `kind=${query.declarationKind}`;
		case "documentation":
			return `docs=${query.terms.join(",")}`;
	}
}

function discoverOptionVariants(params: DiscoverParams): string[] {
	const query = params.query;
	const queryLabels =
		query === undefined
			? ["query"]
			: query.kind === "documentation"
				? shrinkingListVariants(query.terms, `${query.terms.length} terms`).map((part) => `docs=${part}`)
				: [formatQueryLabel(query)];
	const surface = params.surface ?? "surface";
	const limit = params.resultLimit === undefined ? "limit" : `limit=${params.resultLimit}`;
	return queryLabels.map((label) => `[${label} ${surface} ${limit}]`);
}

export function createDiscoverTool(
	rowState: ToolRowStateStore,
	temporaryOutput: TemporaryOutputStore,
	engineFor: (cwd: string) => ExploreEngine,
) {
	return defineTool<typeof discoverParams, ExploreToolDetails>({
		name: "discover",
		label: "discover",
		description:
			"Find reusable declarations across a repository, package, or subtree by name, kind, or documentation. Signatures only — no bodies. Prefer package/public surfaces when looking for imports.",
		promptSnippet: "Find reusable declarations across a repo/package/subtree when path is unknown",
		promptGuidelines: [
			"Use discover when reuse intent is known but the declaration path or exact name is not.",
			"Choose exactly one query kind. Keep fuzzy or documentation work limits narrow.",
			"Use packageSurface when the caller needs a supported public import path (languages with packageSurface capability).",
			"Follow up with show using path+name(+line) when a candidate needs closer inspection.",
		],
		parameters: discoverParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const engine = engineFor(ctx.cwd);
			const abort = signal ?? new AbortController().signal;
			const result = await discover(
				engine,
				params.path,
				params.query as DiscoverQuery,
				params.surface as DiscoverSurface,
				params.resultLimit,
				abort,
			);

			const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
			try {
				const groups = groupDiscoverByFile(result.candidates);
				for (const group of groups) {
					abort.throwIfAborted();
					await builder.appendBlock(
						group.path,
						formatPathForDisplay(group.path, engine.cwd),
						formatDiscoverFile(group.path, group.candidates, engine.cwd),
					);
				}
				if (groups.length === 0) {
					await builder.appendBlock(undefined, "empty", formatDiscoverEmpty());
				}
				const footer = formatDiscoverFooters(result);
				if (footer !== undefined) {
					abort.throwIfAborted();
					await builder.appendRequiredBlock("discover limits", footer);
				}
				const bounded = await builder.finish();
				return {
					content: [{ type: "text", text: bounded.content }],
					details: {
						declarationCount: result.candidates.length,
						returnedBytes: Buffer.byteLength(bounded.content),
						truncated: bounded.overflow.truncated,
					},
				} satisfies DiscoverExecuteResult;
			} catch (error) {
				await builder.abort();
				throw error;
			}
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const targets = [stripLeadingAt(args.path ?? "")];
			const options = discoverOptionVariants(args);
			const component =
				(context.lastComponent as ExploreCallComponent | undefined) ??
				new ExploreCallComponent(rowState, context.toolCallId, "discover", targets, options, theme);
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
