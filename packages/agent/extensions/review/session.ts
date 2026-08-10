import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createIsolatedSessionResource,
	resolveIsolatedSessionModel,
	type IsolatedSessionResource,
} from "../../shared/isolated-session.ts";
import { buildReviewPrompt, REVIEW_RESULT_TOOL, type ReviewOutput } from "./model.ts";

const REVIEW_TOOLS = [
	"read",
	"bash",
	"outline",
	"show",
	"discover",
	"ast_search",
	"deps",
	"reverse_deps",
	"callers",
	"callees",
	"references",
	"implementations",
	"impact",
	"context",
	REVIEW_RESULT_TOOL.name,
];
const EXPLORE_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "explore", "index.ts");

export async function runReview(options: {
	ctx: ExtensionContext;
	root: string;
	direction: string;
	preferredModel: string | undefined;
	preferredThinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]> | undefined;
	parentThinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]>;
	signal: AbortSignal;
}): Promise<ReviewOutput> {
	const { ctx, root, direction, signal } = options;
	let output: ReviewOutput | undefined;
	const outputTool = defineTool({
		...REVIEW_RESULT_TOOL,
		label: "Review Result",
		async execute(_toolCallId, params) {
			output = params;
			return {
				content: [{ type: "text" as const, text: "Review recorded" }],
				details: params,
				terminate: true,
			};
		},
	});
	let resource: IsolatedSessionResource | undefined;
	try {
		const selected = await resolveIsolatedSessionModel({
			label: "Review",
			preferredModel: options.preferredModel,
			preferredThinkingLevel: options.preferredThinkingLevel,
			usePreferredThinkingAfterModelFallback: false,
			ctx,
			parentThinkingLevel: options.parentThinkingLevel,
			signal,
			onWarning: (warning) => ctx.ui.notify(warning, "warning"),
		});
		resource = await createIsolatedSessionResource(
			{
				...selected,
				label: "Review",
				extensionPaths: [EXPLORE_EXTENSION],
				cwd: root,
				tools: REVIEW_TOOLS,
				customTools: [outputTool],
				bindTarget: { mode: "print" },
			},
			signal,
		);
		const { session } = resource;
		const abort = () => void session.abort().catch(() => undefined);
		signal.addEventListener("abort", abort, { once: true });
		try {
			await session.prompt(buildReviewPrompt(root, direction), { expandPromptTemplates: false });
		} finally {
			signal.removeEventListener("abort", abort);
		}
		if (signal.aborted) throw new Error("Review cancelled");
		if (!output) throw new Error("Review ended without structured output");
		return output;
	} finally {
		await resource?.dispose();
	}
}
