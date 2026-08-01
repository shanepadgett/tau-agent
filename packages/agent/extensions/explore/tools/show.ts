import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { Type, type Static } from "typebox";
import { truncateBoundedHead } from "../../../shared/bounded-text-result.ts";
import type { ToolRowStateStore } from "../../../shared/tool-row-state.ts";
import type { ExploreEngine } from "../../../src/ast/engine.ts";
import { formatShowBatch } from "../../../src/ast/format/show.ts";
import { showTargets, type ShowTargetInput } from "../../../src/ast/queries/show.ts";
import { stripLeadingAt } from "../../../src/ast/traverse.ts";
import { ExploreCallComponent, renderExploreResult, shrinkingListVariants, type ExploreToolDetails } from "./render.ts";

const showTargetSchema = Type.Object(
	{
		path: Type.String({ description: "Defining file" }),
		name: Type.String({ minLength: 1, description: "Decl name; dotted Type.method ok" }),
		line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line inside decl range" })),
	},
	{ additionalProperties: false },
);

const showParams = Type.Object(
	{
		targets: Type.Array(showTargetSchema, {
			minItems: 1,
			description: "path+name targets (optional line pin)",
		}),
		view: StringEnum(["signature", "signatureWithDocs", "declaration", "declarationWithImports"] as const, {
			description: "signature | signatureWithDocs | declaration | declarationWithImports",
		}),
		contextLines: Type.Optional(
			Type.Integer({
				minimum: 0,
				description: "Extra lines around decl (declaration only)",
			}),
		),
	},
	{ additionalProperties: false },
);

type ShowParams = Static<typeof showParams>;

function showTargetVariants(targets: readonly ShowTargetInput[]): string[] {
	if (targets.length === 0) return ["targets"];
	const fileCount = new Set(targets.map((target) => stripLeadingAt(target.path))).size;
	if (fileCount === 1) {
		const first = targets[0];
		const file = first === undefined ? "file" : basename(stripLeadingAt(first.path));
		return shrinkingListVariants(
			targets.map((target) => target.name),
			`${targets.length} symbols`,
		).map((part) => `${file}: ${part}`);
	}
	return shrinkingListVariants(
		targets.map((target) => `${target.name}@${basename(stripLeadingAt(target.path))}`),
		`${targets.length} symbols in ${fileCount} files`,
	);
}

function showOptionLabel(params: ShowParams): string {
	const context =
		params.contextLines === undefined || params.view !== "declaration" ? "" : ` context=${params.contextLines}`;
	return `[${params.view}${context}]`;
}

export function createShowTool(rowState: ToolRowStateStore, engineFor: (cwd: string) => ExploreEngine) {
	return defineTool<typeof showParams, ExploreToolDetails>({
		name: "show",
		label: "show",
		description:
			"Exact signature or source for path+name targets. Whole batch fails on any missing/ambiguous target (candidate list, no partials). Views: signature → signatureWithDocs → declaration → declarationWithImports. Over budget throws — request fewer targets (bodies are not truncated).",
		promptSnippet: "Signature or source for path+name targets",
		promptGuidelines: [
			"Cheapest view that answers; declarationWithImports only when edits need imports.",
			"Pin with path and line when names collide — do not guess.",
		],
		parameters: showParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const engine = engineFor(ctx.cwd);
			const abort = signal ?? new AbortController().signal;
			const batch = await showTargets(engine, params.targets, params.view, params.contextLines, abort);
			const text = formatShowBatch(batch, engine.cwd);
			const bounded = truncateBoundedHead(text);
			if (bounded.truncated) {
				throw new Error("show result exceeded the model-output budget. Request fewer targets.");
			}
			return {
				content: [{ type: "text", text }],
				details: {
					declarationCount: batch.blocks.length,
					returnedBytes: Buffer.byteLength(text),
					truncated: false,
				},
			};
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const targets = showTargetVariants(args.targets ?? []);
			const options = [showOptionLabel(args)];
			const component =
				(context.lastComponent as ExploreCallComponent | undefined) ??
				new ExploreCallComponent(rowState, context.toolCallId, "show", targets, options, theme);
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
