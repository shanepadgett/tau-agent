import {
	createReadToolDefinition,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
	type ReadToolDetails,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { normalizeCountLimit } from "./limits.ts";
import { stripLeadingAt } from "./path-display.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	lineNumbers: Type.Optional(Type.Boolean({ description: "Prefix text lines with their 1-indexed file line number" })),
});

type ReadToolInput = Static<typeof readSchema>;
type BaseReadDefinition = ReturnType<typeof createReadToolDefinition>;
type ReadDefinition = ToolDefinition<typeof readSchema, ReadToolDetails | undefined>;
type ReadExecute = ReadDefinition["execute"];
type ReadRenderCall = NonNullable<ReadDefinition["renderCall"]>;
type ReadRenderResult = NonNullable<ReadDefinition["renderResult"]>;

const readDefinitionByCwd = new Map<string, BaseReadDefinition>();

function readDefinitionForCwd(cwd: string): BaseReadDefinition {
	const existing = readDefinitionByCwd.get(cwd);
	if (existing) return existing;
	const definition = createReadToolDefinition(cwd);
	readDefinitionByCwd.set(cwd, definition);
	return definition;
}

function normalizeReadParams(params: ReadToolInput): ReadToolInput {
	return {
		...params,
		path: stripLeadingAt(params.path),
		limit: params.limit === undefined ? undefined : normalizeCountLimit(params.limit, 1),
	};
}

function isSupportedImage(buffer: Buffer): boolean {
	return (
		(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
		buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
		buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
		buffer.subarray(0, 6).toString("ascii") === "GIF89a" ||
		(buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") ||
		buffer.subarray(0, 2).toString("ascii") === "BM"
	);
}

function renderCallSummary(args: ReadToolInput | undefined): string {
	if (!args) return "";
	const path = stripLeadingAt(args.path);
	if (args.offset === undefined && args.limit === undefined) return path;
	const start = args.offset ?? 1;
	const limit = args.limit === undefined ? undefined : normalizeCountLimit(args.limit, 1);
	const end = limit === undefined ? "" : start + limit - 1;
	return `${path}:${start}${end === "" ? "" : `-${end}`}`;
}

export function createExploreReadTool(rowState: ToolRowStateStore): ReadDefinition {
	const baseDefinition = readDefinitionForCwd(process.cwd());
	return {
		...baseDefinition,
		parameters: readSchema,
		async execute(
			toolCallId: Parameters<ReadExecute>[0],
			params: Parameters<ReadExecute>[1],
			signal: Parameters<ReadExecute>[2],
			onUpdate: Parameters<ReadExecute>[3],
			ctx: Parameters<ReadExecute>[4],
		) {
			const definition = readDefinitionForCwd(ctx.cwd);
			const normalized = normalizeReadParams(params);
			const path = isAbsolute(normalized.path) ? normalized.path : resolve(ctx.cwd, normalized.path);
			const buffer = await readFile(path);
			if (isSupportedImage(buffer)) {
				return definition.execute(
					toolCallId,
					{ path: normalized.path, offset: normalized.offset, limit: normalized.limit },
					signal,
					onUpdate,
					ctx,
				);
			}

			if (signal?.aborted) throw new Error("Operation aborted");
			const allLines = buffer.toString("utf-8").split("\n");
			const startLine = normalized.offset ? Math.max(0, normalized.offset - 1) : 0;
			const startLineDisplay = startLine + 1;
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${normalized.offset} is beyond end of file (${allLines.length} lines total)`);
			}

			const endLine =
				normalized.limit === undefined ? allLines.length : Math.min(startLine + normalized.limit, allLines.length);
			const selectedLines = allLines.slice(startLine, endLine);
			const selectedContent = selectedLines
				.map((line, index) => (normalized.lineNumbers ? `${startLineDisplay + index}: ${line}` : line))
				.join("\n");
			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let details: ReadToolDetails | undefined;
			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(Buffer.byteLength(selectedLines[0] ?? "", "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${normalized.path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				outputText +=
					truncation.truncatedBy === "lines"
						? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}. Use offset=${nextOffset} to continue.]`
						: `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				details = { truncation };
			} else if (endLine < allLines.length) {
				outputText = `${truncation.content}\n\n[${allLines.length - endLine} more lines in file. Use offset=${endLine + 1} to continue.]`;
			} else {
				outputText = truncation.content;
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
		renderCall(
			args: Parameters<ReadRenderCall>[0],
			theme: Parameters<ReadRenderCall>[1],
			context: Parameters<ReadRenderCall>[2],
		) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "read", theme);
			text.setText(`${title} ${theme.fg("muted", renderCallSummary(args))}`);
			return text;
		},
		renderResult(
			result: Parameters<ReadRenderResult>[0],
			options: Parameters<ReadRenderResult>[1],
			theme: Parameters<ReadRenderResult>[2],
			context: Parameters<ReadRenderResult>[3],
		) {
			if (!context.expanded) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText("");
				return text;
			}
			const definition = readDefinitionForCwd(context.cwd);
			return definition.renderResult?.(result, { ...options, expanded: true }, theme, context) ?? new Text("", 0, 0);
		},
	};
}
