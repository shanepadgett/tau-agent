import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { BoundedTextResultBuilder, type BoundedTextOverflowDetails } from "../../shared/bounded-text-result.ts";
import type { TemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { clampInteger, normalizeTimeout } from "./limits.ts";
import { createSearchService } from "./search.ts";
import type { SearchResult } from "./search-types.ts";
import { renderWebToolResult, truncateCallSummary } from "./tool-output.ts";

const webSearchParams = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Web research query" }),
		maxSources: Type.Optional(Type.Number({ description: "Maximum returned sources (default: 8, max: 12)" })),
		contextMaxCharacters: Type.Optional(
			Type.Number({ description: "Requested research text budget (default: 10000, range: 500-30000)" }),
		),
		timeout: Type.Optional(Type.Number({ description: "Overall search timeout in seconds (default: 25, max: 600)" })),
	},
	{ additionalProperties: false },
);

type WebSearchParams = Static<typeof webSearchParams>;
interface WebSearchDetails {
	query: string;
	maxSources: number;
	contextMaxCharacters: number;
	backend: SearchResult["backend"];
	model: string | null;
	fallback: SearchResult["fallback"];
	overflow: BoundedTextOverflowDetails;
}

export function createWebSearchTool(rowState: ToolRowStateStore, temporaryOutput: TemporaryOutputStore) {
	const search = createSearchService();
	return defineTool<typeof webSearchParams, WebSearchDetails | undefined>({
		name: "websearch",
		label: "Web Search",
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		description:
			"Research the public web using the active provider's hosted search, with Exa fallback. Returns research text and source links. Use websearch for broad discovery, then webfetch for a known URL. Large results include a session temporary-file path.",
		parameters: webSearchParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) throw new Error("Web search query must not be empty");
			const timeoutSeconds = normalizeTimeout(params.timeout, 25);
			const maxSources = clampInteger(params.maxSources, 8, 1, 12);
			const contextMaxCharacters = clampInteger(params.contextMaxCharacters, 10_000, 500, 30_000);
			await onUpdate?.({ content: [{ type: "text", text: "Searching web..." }], details: undefined });
			const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
			try {
				const result = await search(ctx, { query, maxSources, contextMaxCharacters, timeoutSeconds }, signal);
				for (const [index, paragraph] of result.text.split(/\n\s*\n/).entries()) {
					signal?.throwIfAborted();
					if (paragraph.trim()) await builder.appendBlock(undefined, `Research paragraph ${index + 1}`, paragraph);
				}
				for (const source of result.sources) {
					signal?.throwIfAborted();
					await builder.appendBlock(source.url, "Source", `${source.title}\n${source.url}`);
				}
				signal?.throwIfAborted();
				const bounded = await builder.finish();
				return {
					content: [{ type: "text", text: bounded.content }],
					details: {
						query,
						maxSources,
						contextMaxCharacters,
						backend: result.backend,
						model: result.model,
						fallback: result.fallback,
						overflow: bounded.overflow,
					},
				};
			} catch (error) {
				await builder.abort();
				if (error instanceof Error && error.name === "TimeoutError") {
					throw new Error(`Web search timed out after ${timeoutSeconds}s`);
				}
				throw error;
			}
		},
		renderCall(args: WebSearchParams, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "websearch", theme);
			const summary = truncateCallSummary((args.query ?? "").trim()) || "…";
			text.setText(
				`${title} ${theme.fg("accent", summary)} ${theme.fg("muted", `(sources≤${clampInteger(args.maxSources, 8, 1, 12)})`)}`,
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderWebToolResult(result, options, theme, context);
		},
	});
}
