import {
	createReadToolDefinition,
	DEFAULT_MAX_BYTES,
	formatSize,
	generateUnifiedPatch,
	truncateHead,
	type ReadToolDetails,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { normalizeCountLimit } from "./limits.ts";
import { stripLeadingAt } from "./path-display.ts";
import { createReadCacheStore, type ReadCacheMetaV1, type ReadCacheStore } from "./read-cache.ts";
import { createReadSnapshotStore, type ReadSnapshotStore } from "./read-snapshots.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	lineNumbers: Type.Optional(Type.Boolean({ description: "Prefix text lines with their 1-indexed file line number" })),
});

type ReadToolInput = Static<typeof readSchema>;
type BaseReadDefinition = ReturnType<typeof createReadToolDefinition>;
interface ExploreReadDetails extends ReadToolDetails {
	readCache?: ReadCacheMetaV1;
}
type ReadDefinition = ToolDefinition<typeof readSchema, ExploreReadDetails | undefined>;
type ReadExecute = ReadDefinition["execute"];
type ReadRenderCall = NonNullable<ReadDefinition["renderCall"]>;
type ReadRenderResult = NonNullable<ReadDefinition["renderResult"]>;

interface BaselineTextResult {
	text: string;
	details: ReadToolDetails | undefined;
	totalLines: number;
	startLine: number;
	endLine: number;
	completeFile: boolean;
	scopeKey: string;
	summary: string;
	cacheable: boolean;
}

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

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function baselineText(text: string, params: ReadToolInput): BaselineTextResult {
	const allLines = text.split("\n");
	const startIndex = params.offset ? Math.max(0, params.offset - 1) : 0;
	const startLine = startIndex + 1;
	if (startIndex >= allLines.length) {
		throw new Error(`Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`);
	}

	const selectedEnd =
		params.limit === undefined ? allLines.length : Math.min(startIndex + params.limit, allLines.length);
	const selectedLines = allLines.slice(startIndex, selectedEnd);
	const selectedContent = selectedLines
		.map((line, index) => (params.lineNumbers ? `${startLine + index}: ${line}` : line))
		.join("\n");
	const truncation = truncateHead(selectedContent);
	let outputText: string;
	let details: ReadToolDetails | undefined;
	let outputLines = selectedLines.length;
	let cacheable = true;

	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(selectedLines[0] ?? "", "utf-8"));
		outputText = `[Line ${startLine} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLine}p' ${params.path} | head -c ${DEFAULT_MAX_BYTES}]`;
		details = { truncation };
		outputLines = 0;
		cacheable = false;
	} else if (truncation.truncated) {
		outputLines = truncation.outputLines;
		const endLineDisplay = startLine + outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = truncation.content;
		outputText +=
			truncation.truncatedBy === "lines"
				? `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${allLines.length}. Use offset=${nextOffset} to continue.]`
				: `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		details = { truncation };
	} else if (selectedEnd < allLines.length) {
		outputText = `${truncation.content}\n\n[${allLines.length - selectedEnd} more lines in file. Use offset=${selectedEnd + 1} to continue.]`;
	} else {
		outputText = truncation.content;
	}

	const endLine = outputLines === 0 ? startLine : startLine + outputLines - 1;
	const completeFile = startIndex === 0 && selectedEnd === allLines.length && !truncation.truncated;
	const scopeKey = `${completeFile ? "full" : `r:${startLine}:${endLine}`}:n${params.lineNumbers ? 1 : 0}`;
	const summary = completeFile ? `${allLines.length} lines` : `${outputLines} lines`;
	return {
		text: outputText,
		details,
		totalLines: allLines.length,
		startLine,
		endLine,
		completeFile,
		scopeKey,
		summary,
		cacheable,
	};
}

function withMeta(baseline: BaselineTextResult, meta: ReadCacheMetaV1, text = baseline.text) {
	return {
		content: [{ type: "text" as const, text }],
		details: { ...baseline.details, readCache: meta },
	};
}

function createMeta(
	baseline: BaselineTextResult,
	pathKey: string,
	hash: string,
	mode: ReadCacheMetaV1["mode"],
	returnedText: string,
	baseHash?: string,
	summary = baseline.summary,
): ReadCacheMetaV1 {
	return {
		v: 1,
		pathKey,
		scopeKey: baseline.scopeKey,
		servedHash: hash,
		baseHash,
		mode,
		baselineTokens: estimateTokens(baseline.text),
		returnedTokens: estimateTokens(returnedText),
		totalLines: baseline.totalLines,
		summary,
	};
}

function countDiffLines(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return { added, removed };
}

export function createExploreReadTool(
	rowState: ToolRowStateStore,
	cache: ReadCacheStore = createReadCacheStore(),
	snapshots: ReadSnapshotStore = createReadSnapshotStore(),
): ReadDefinition {
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
			const path = isAbsolute(normalized.path) ? resolve(normalized.path) : resolve(ctx.cwd, normalized.path);
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
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
			} catch {
				return definition.execute(toolCallId, normalized, signal, onUpdate, ctx);
			}

			const baseline = baselineText(text, normalized);
			if (!baseline.cacheable) {
				return { content: [{ type: "text", text: baseline.text }], details: baseline.details };
			}
			const hash = createHash("sha256").update(buffer).digest("hex");
			const decision = cache.decision(ctx, path, baseline.scopeKey);
			let output = baseline.text;
			let mode: ReadCacheMetaV1["mode"] = decision.recovery ? "recovery" : "baseline";
			let summary = baseline.summary;

			if (!decision.recovery && decision.baseHash === hash) {
				output = baseline.completeFile
					? `unchanged, ${baseline.totalLines} lines`
					: `unchanged, lines ${baseline.startLine}-${baseline.endLine} of ${baseline.totalLines}`;
				mode = "unchanged";
				summary = output;
			} else if (!decision.recovery && decision.baseHash && baseline.completeFile && !normalized.lineNumbers) {
				const baseText = snapshots.get(decision.baseHash);
				if (baseText !== undefined) {
					const patch = generateUnifiedPatch(normalized.path, baseText, text, 3);
					const counts = countDiffLines(patch);
					const candidate = `[read: ${counts.added} lines added, ${counts.removed} removed of ${baseline.totalLines}]\n${patch}`;
					const candidateTruncation = truncateHead(candidate);
					if (!candidateTruncation.truncated && estimateTokens(candidate) < estimateTokens(baseline.text)) {
						output = candidate;
						mode = "diff";
						summary = `+${counts.added} -${counts.removed}`;
					}
				}
			}

			if (signal?.aborted) throw new Error("Operation aborted");
			snapshots.set(hash, text, buffer.byteLength);
			const meta = createMeta(baseline, path, hash, mode, output, decision.baseHash, summary);
			cache.record(ctx, meta);
			return withMeta(baseline, meta, output);
		},
		renderCall(
			args: Parameters<ReadRenderCall>[0],
			theme: Parameters<ReadRenderCall>[1],
			context: Parameters<ReadRenderCall>[2],
		) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (context.executionStarted || !context.isPartial) {
				text.setText("");
				return text;
			}
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
			rowState.watch(context.toolCallId, context.invalidate);
			const container = new Container();
			const title = formatToolRowTitle(rowState, context.toolCallId, "read", theme);
			const args = context.args as ReadToolInput | undefined;
			const details = result.details as ExploreReadDetails | undefined;
			const summary = details?.readCache?.summary;
			const summaryText = context.isError
				? theme.fg("error", "error")
				: summary
					? theme.fg(
							details?.readCache?.mode === "unchanged"
								? "success"
								: details?.readCache?.mode === "diff"
									? "accent"
									: "muted",
							summary,
						)
					: "";
			const header = `${title} ${theme.fg("muted", renderCallSummary(args))}${summaryText ? `  ${summaryText}` : ""}`;
			container.addChild(new Text(header, 0, 0));
			if (options.expanded) {
				const definition = readDefinitionForCwd(context.cwd);
				const body = definition.renderResult?.(result, { ...options, expanded: true }, theme, context);
				if (body) container.addChild(body);
			}
			return container;
		},
	};
}
