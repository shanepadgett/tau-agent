import { defineTool, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { callExa } from "./exa.ts";
import { clampInteger, normalizeTimeout } from "./limits.ts";
import { renderWebToolResult, truncateCallSummary, truncateToolOutput } from "./tool-output.ts";

const codeSearchParams = Type.Object(
	{
		query: Type.String({ description: "Code or documentation search query" }),
		tokensNum: Type.Optional(Type.Number({ description: "Target context token budget (default: 5000)" })),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 25, max: 600)" })),
	},
	{ additionalProperties: false },
);

type CodeSearchParams = Static<typeof codeSearchParams>;
interface CodeSearchDetails {
	query: string;
	tokensNum: number;
	truncation?: TruncationResult;
}

export function createCodeSearchTool(rowState: ToolRowStateStore) {
	return defineTool<typeof codeSearchParams, CodeSearchDetails | undefined>({
		name: "codesearch",
		label: "Code Search",
		description:
			"Search Exa for API usage, code examples, and implementation-oriented documentation context. Use websearch for broad discovery and webfetch for a known URL. Use a separate research workflow when several searches, fetches, and synthesis are needed. Output is truncated to 2,000 lines or 50 KB.",
		parameters: codeSearchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const timeout = normalizeTimeout(params.timeout, 25);
			const tokensNum = clampInteger(params.tokensNum, 5000, 500, 20_000);
			await onUpdate?.({ content: [{ type: "text", text: "Searching code context..." }], details: undefined });
			try {
				const output =
					(await callExa(
						{ toolName: "get_code_context_exa", arguments: { query: params.query, tokensNum } },
						signal,
						timeout,
					)) ?? "No code context found. Try a more specific query with library/language names.";
				const truncated = truncateToolOutput(output);
				return {
					content: [{ type: "text", text: truncated.text }],
					details: {
						query: params.query,
						tokensNum,
						...(truncated.truncation ? { truncation: truncated.truncation } : {}),
					},
				};
			} catch (error) {
				if (error instanceof Error && error.name === "TimeoutError") {
					throw new Error(`Code search timed out after ${timeout}s`);
				}
				throw error;
			}
		},
		renderCall(args: CodeSearchParams, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "codesearch", theme);
			const summary = truncateCallSummary((args.query ?? "").trim()) || "…";
			text.setText(
				`${title} ${theme.fg("accent", summary)} ${theme.fg("muted", `(tokens=${clampInteger(args.tokensNum, 5000, 500, 20_000)})`)}`,
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderWebToolResult(result, options, theme, context);
		},
	});
}
