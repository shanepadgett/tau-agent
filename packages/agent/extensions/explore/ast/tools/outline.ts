import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { BoundedTextResultBuilder } from "../../../../shared/bounded-text-result.ts";
import type { TemporaryOutputStore } from "../../../../shared/temporary-output-store.ts";
import type { ToolRowStateStore } from "../../../../shared/tool-row-state.ts";
import type { ExploreEngine } from "../engine.ts";
import { formatOutlineBudgetFooter, formatOutlineEmpty, formatOutlineFile } from "../format/outline.ts";
import { outlinePath, outlineRecursive, type OutlineFileView, type OutlineOptions } from "../queries/outline.ts";
import { formatPathForDisplay, stripLeadingAt } from "../../traverse.ts";
import { ExploreCallComponent, renderExploreResult, type ExploreToolDetails } from "./render.ts";

const outlineParams = Type.Object(
	{
		path: Type.String({
			description: "Supported source file, package directory, or subtree",
		}),
		includePrivate: Type.Optional(
			Type.Boolean({ description: "Include private declarations and members (default false)" }),
		),
		includeDocs: Type.Optional(
			Type.Boolean({ description: "Include attached documentation comments (default false)" }),
		),
		names: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description: "Exact declaration name or qualifiedName filters",
			}),
		),
		recursive: Type.Optional(
			Type.Boolean({ description: "Recursively outline every supported source file below a directory" }),
		),
	},
	{ additionalProperties: false },
);

type OutlineParams = Static<typeof outlineParams>;

type OutlineExecuteResult = {
	content: Array<{ type: "text"; text: string }>;
	details: ExploreToolDetails;
};

function outlineOptions(params: OutlineParams): OutlineOptions {
	return {
		includePrivate: params.includePrivate === true,
		includeDocs: params.includeDocs === true,
		names: params.names ?? [],
	};
}

function outlineOptionVariants(params: OutlineParams): string[] {
	const fixed = [
		...(params.recursive === true ? ["recursive"] : []),
		...(params.includePrivate === true ? ["private"] : []),
		...(params.includeDocs === true ? ["docs"] : []),
	];
	const names = params.names ?? [];
	if (names.length === 0) return [fixed.length > 0 ? `[${fixed.join(" ")}]` : ""];
	const variants: string[] = [];
	for (let shown = names.length; shown >= 1; shown -= 1) {
		const omitted = names.length - shown;
		const namesText = omitted > 0 ? `${names.slice(0, shown).join(",")},+${omitted}` : names.join(",");
		variants.push(`[${[...fixed, `names=${namesText}`].join(" ")}]`);
	}
	variants.push(`[${[...fixed, `names=${names.length}`].join(" ")}]`);
	return variants;
}

function emptyMessage(file: OutlineFileView, names: readonly string[]): string {
	const base = formatOutlineEmpty(names);
	if (!file.parseDegraded) return base;
	return `warning: parser recovered with errors\n${base}`;
}

async function withBoundedOutline(
	temporaryOutput: TemporaryOutputStore,
	signal: AbortSignal,
	run: (builder: BoundedTextResultBuilder) => Promise<number>,
): Promise<OutlineExecuteResult> {
	const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
	try {
		const declarationCount = await run(builder);
		signal.throwIfAborted();
		const bounded = await builder.finish();
		return {
			content: [{ type: "text", text: bounded.content }],
			details: {
				declarationCount,
				returnedBytes: Buffer.byteLength(bounded.content),
				truncated: bounded.overflow.truncated,
			},
		};
	} catch (error) {
		await builder.abort();
		throw error;
	}
}

export function createOutlineTool(
	rowState: ToolRowStateStore,
	temporaryOutput: TemporaryOutputStore,
	engineFor: (cwd: string) => ExploreEngine,
) {
	return defineTool<typeof outlineParams, ExploreToolDetails>({
		name: "outline",
		label: "outline",
		description:
			"Inspect declarations in one supported source file, one non-recursive package directory, or a recursive mixed-language subtree without returning implementation bodies. Line ranges support follow-up show or ranged read.",
		promptSnippet: "Inspect declarations and structure without reading implementation bodies",
		promptGuidelines: [
			"Set recursive=true to orient an unfamiliar repository or subtree across supported languages.",
			"Leave includePrivate off for surface discovery; enable it only for targeted internal implementation work.",
			"Leave includeDocs off when names and signatures answer the question; enable it only when documentation comments matter.",
			"Use show with path+name (and optional line) when exact signature or declaration source is needed.",
		],
		parameters: outlineParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const engine = engineFor(ctx.cwd);
			const options = outlineOptions(params);
			const abort = signal ?? new AbortController().signal;

			if (params.recursive === true) {
				return withBoundedOutline(temporaryOutput, abort, async (builder) => {
					let declarationCount = 0;
					let emitted = 0;
					const stream = outlineRecursive(engine, params.path, options, abort);
					let step = await stream.next();
					while (!step.done) {
						abort.throwIfAborted();
						const file = step.value;
						declarationCount += file.rows.length;
						emitted += 1;
						await builder.appendBlock(
							file.path,
							formatPathForDisplay(file.path, engine.cwd),
							formatOutlineFile(file, engine.cwd, true),
						);
						step = await stream.next();
					}
					if (emitted === 0) {
						await builder.appendBlock(undefined, "empty", formatOutlineEmpty(options.names));
					}
					const footer = formatOutlineBudgetFooter(step.value);
					if (footer !== undefined) {
						abort.throwIfAborted();
						await builder.appendRequiredBlock("outline limits", footer);
					}
					return declarationCount;
				});
			}

			const result = await outlinePath(engine, params.path, options, abort);

			if (result.mode === "file") {
				const text =
					result.file.rows.length === 0
						? emptyMessage(result.file, options.names)
						: formatOutlineFile(result.file, engine.cwd, false);
				return withBoundedOutline(temporaryOutput, abort, async (builder) => {
					abort.throwIfAborted();
					await builder.appendBlock(result.file.path, formatPathForDisplay(result.file.path, engine.cwd), text);
					return result.file.rows.length;
				});
			}

			if (result.files.length === 0) {
				return withBoundedOutline(temporaryOutput, abort, async (builder) => {
					abort.throwIfAborted();
					await builder.appendBlock(undefined, "empty", formatOutlineEmpty(options.names));
					return 0;
				});
			}

			return withBoundedOutline(temporaryOutput, abort, async (builder) => {
				let declarationCount = 0;
				for (const file of result.files) {
					abort.throwIfAborted();
					declarationCount += file.rows.length;
					await builder.appendBlock(
						file.path,
						formatPathForDisplay(file.path, engine.cwd),
						formatOutlineFile(file, engine.cwd, true),
					);
				}
				return declarationCount;
			});
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const targets = [stripLeadingAt(args.path ?? "")];
			const options = outlineOptionVariants(args);
			const component =
				(context.lastComponent as ExploreCallComponent | undefined) ??
				new ExploreCallComponent(rowState, context.toolCallId, "outline", targets, options, theme);
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
