import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withSearchEvidence } from "./evidence.ts";
import { displayPath, resolveSearchPath } from "./path-utils.ts";
import type { SearchRenderState } from "./render-state.ts";

const readParams = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Number({
			description: "Line number to start reading from (1-indexed). Do not use for repo-owned work files.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of lines to read. Do not use for repo-owned work files." }),
	),
});

export function registerReadTool(pi: ExtensionAPI, _renderState: SearchRenderState): void {
	pi.registerTool({
		...createReadToolDefinition(process.cwd()),
		name: "read",
		label: "Read",
		description:
			"Read file contents. For repo-owned work files, read the whole file with no offset or limit. Supports text files and images.",
		promptSnippet: "Read file contents",
		promptGuidelines: [
			"Use read to examine files instead of cat or sed.",
			"Use read with no offset or limit for repo-owned work files.",
			"Do not use read offset or limit on repo-owned work files; partial reads are only for external docs, dependencies, vendor/generated files, or non-work huge files.",
		],
		parameters: readParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const builtin = createReadToolDefinition(ctx.cwd);
			const result = await builtin.execute(toolCallId, params, signal, onUpdate, ctx);
			const absolutePath = resolveSearchPath(ctx.cwd, params.path);
			if (!absolutePath || result.content.some((block) => block.type !== "text")) return result;
			const current = params.offset === undefined && params.limit === undefined && !isTruncated(result.details);
			return {
				...result,
				details: withSearchEvidence(
					typeof result.details === "object" && result.details !== null ? result.details : undefined,
					{
						version: 1,
						kind: "read",
						role: current ? "current" : "navigation",
						paths: [displayPath(ctx.cwd, absolutePath)],
						complete: current,
						toolCallId,
					},
				),
			};
		},
		renderCall(args, theme, context) {
			const builtin = createReadToolDefinition(context.cwd);
			return builtin.renderCall ? builtin.renderCall(args, theme, context) : (undefined as never);
		},
		renderResult(result, options, theme, context) {
			const builtin = createReadToolDefinition(context.cwd);
			return builtin.renderResult
				? builtin.renderResult(result as never, options, theme, context)
				: (undefined as never);
		},
	});
}

function isTruncated(details: unknown): boolean {
	return typeof details === "object" && details !== null && "truncation" in details;
}
