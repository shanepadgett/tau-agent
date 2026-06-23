import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	createReadToolDefinition,
	defineTool,
	formatSize,
	type ReadToolDetails,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const MAX_LINES = 6000;
const MAX_BYTES = 150 * 1024;
const SEPARATOR = "────";
const DETAILS_KIND = "file-operations.read";

const rangeSchema = Type.Object({
	offset: Type.Number({ description: "Line number to start reading from (1-indexed)" }),
	limit: Type.Number({ description: "Maximum number of lines to read" }),
});

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	ranges: Type.Optional(Type.Array(rangeSchema, { description: "Multiple file ranges to read" })),
});

type ReadInput = Static<typeof readSchema>;

type RequestedRange = {
	offset: number;
	limit?: number;
};

type ReturnedRange = {
	startLine: number;
	endLine: number;
	text: string;
};

type FileOperationsReadDetails = {
	kind: typeof DETAILS_KIND;
	handle: string;
	path: string;
	canonicalPath: string;
	digest: string;
	lineCount: number;
	newline: "lf" | "crlf" | "mixed" | "none";
	ranges: ReturnedRange[];
	userText: string;
	truncated: boolean;
};

type ReadDetails = FileOperationsReadDetails | ReadToolDetails | undefined;

type ReadState = {
	nextHandle: number;
	records: Map<string, FileOperationsReadDetails>;
};

type SelectedLine = {
	lineNumber: number;
	text: string;
};

type SelectedRange = {
	startLine: number;
	endLine: number;
	lines: SelectedLine[];
	truncated: boolean;
};

export function createFileOperationsReadTool(cwd: string): ToolDefinition<typeof readSchema, ReadDetails> {
	const state: ReadState = { nextHandle: 1, records: new Map() };
	const originalRead = createReadToolDefinition(cwd);

	return defineTool<typeof readSchema, ReadDetails>({
		name: "read",
		label: "read",
		description: `Read file contents. Text output is line-addressed for patching and capped at ${MAX_LINES} lines or ${formatSize(MAX_BYTES)}. Supports images through Pi's built-in read behavior. Use offset/limit or ranges for large files.`,
		promptSnippet: "Read file contents with line numbers for later patching",
		promptGuidelines: [
			"Use read to examine files instead of cat or sed.",
			"Read output lines are prefixed as lineNumber| content; remove that prefix when using edit oldText.",
		],
		parameters: readSchema,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");
			validateInput(params);

			const absolutePath = resolvePath(cwd, params.path);
			await access(absolutePath, constants.R_OK);

			const buffer = await readFile(absolutePath);
			if (isSupportedImage(buffer)) {
				return originalRead.execute(toolCallId, params, signal, onUpdate, ctx);
			}
			if (signal?.aborted) throw new Error("Operation aborted");

			const canonicalPath = await realpath(absolutePath);
			const text = buffer.toString("utf8");
			const lines = text.split("\n");
			const requestedRanges = normalizeRequestedRanges(params);
			const selected = selectRanges(lines, requestedRanges);
			const returnedRanges = selected.ranges.map((range) => ({
				startLine: range.startLine,
				endLine: range.endLine,
				text: range.lines.map((line) => line.text).join("\n"),
			}));
			const userText = formatNumberedRanges(selected.ranges);
			const handle = `@f${state.nextHandle++}`;
			const details: FileOperationsReadDetails = {
				kind: DETAILS_KIND,
				handle,
				path: params.path,
				canonicalPath,
				digest: `sha256:${createHash("sha256").update(buffer).digest("hex")}`,
				lineCount: lines.length,
				newline: detectNewline(text),
				ranges: returnedRanges,
				userText,
				truncated: selected.truncated,
			};
			state.records.set(handle, details);

			const notes = continuationNotes(params, selected, lines.length);
			const modelText = [formatHeader(handle, params.path, returnedRanges), userText, ...notes]
				.filter(Boolean)
				.join("\n");
			if (notes.length > 0) details.userText = [userText, ...notes].filter(Boolean).join("\n");

			return {
				content: [{ type: "text", text: modelText }],
				details,
			};
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", args.path)}${theme.fg("warning", formatRangeSuffix(args))}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme, context) {
			if (!context.expanded && !context.isError) return new Text("", 0, 0);

			if (isFileOperationsReadDetails(result.details)) {
				return new Text(`\n${renderUserText(result.details.userText, theme)}`, 0, 0);
			}

			const content = result.content.find((item) => item.type === "text");
			return new Text(content ? `\n${theme.fg(context.isError ? "error" : "toolOutput", content.text)}` : "", 0, 0);
		},
	});
}

function validateInput(input: ReadInput): void {
	const hasRanges = input.ranges !== undefined;
	if (hasRanges && (input.offset !== undefined || input.limit !== undefined)) {
		throw new Error("read ranges cannot be combined with offset or limit");
	}
	if (input.offset !== undefined) assertPositiveInteger(input.offset, "offset");
	if (input.limit !== undefined) assertPositiveInteger(input.limit, "limit");
	if (input.ranges !== undefined) {
		if (input.ranges.length === 0) throw new Error("read ranges must not be empty");
		for (const [index, range] of input.ranges.entries()) {
			assertPositiveInteger(range.offset, `ranges[${index}].offset`);
			assertPositiveInteger(range.limit, `ranges[${index}].limit`);
		}
	}
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function normalizeRequestedRanges(input: ReadInput): RequestedRange[] {
	if (input.ranges) return input.ranges.map((range) => ({ offset: range.offset, limit: range.limit }));
	return [{ offset: input.offset ?? 1, limit: input.limit }];
}

function selectRanges(
	lines: string[],
	requestedRanges: RequestedRange[],
): { ranges: SelectedRange[]; truncated: boolean } {
	const ranges: SelectedRange[] = [];
	let remainingLines = MAX_LINES;
	let remainingBytes = MAX_BYTES;
	let truncated = false;

	for (const requested of requestedRanges) {
		if (ranges.length > 0) {
			remainingBytes -= Buffer.byteLength(`\n\n${SEPARATOR}\n\n`, "utf8");
		}
		if (remainingLines <= 0 || remainingBytes <= 0) {
			truncated = true;
			break;
		}
		const startIndex = requested.offset - 1;
		if (startIndex >= lines.length) {
			throw new Error(`Offset ${requested.offset} is beyond end of file (${lines.length} lines total)`);
		}

		const requestedEnd =
			requested.limit === undefined ? lines.length : Math.min(startIndex + requested.limit, lines.length);
		const selectedLines: SelectedLine[] = [];
		let hitCap = false;
		for (let index = startIndex; index < requestedEnd; index++) {
			if (remainingLines <= 0) {
				hitCap = true;
				break;
			}
			const line = lines[index] ?? "";
			const formattedLine = `${index + 1}| ${line}`;
			const lineBytes = Buffer.byteLength(formattedLine, "utf8") + (selectedLines.length > 0 ? 1 : 0);
			if (lineBytes > remainingBytes) {
				hitCap = true;
				break;
			}
			selectedLines.push({ lineNumber: index + 1, text: line });
			remainingLines--;
			remainingBytes -= lineBytes;
		}

		if (selectedLines.length === 0) {
			throw new Error(`Line ${requested.offset} exceeds ${formatSize(MAX_BYTES)} read limit`);
		}

		ranges.push({
			startLine: selectedLines[0]?.lineNumber ?? requested.offset,
			endLine: selectedLines[selectedLines.length - 1]?.lineNumber ?? requested.offset,
			lines: selectedLines,
			truncated: hitCap,
		});
		if (hitCap) {
			truncated = true;
			break;
		}
	}

	return { ranges, truncated };
}

function continuationNotes(
	input: ReadInput,
	selected: { ranges: SelectedRange[]; truncated: boolean },
	lineCount: number,
): string[] {
	const lastRange = selected.ranges[selected.ranges.length - 1];
	if (!lastRange) return [];

	if (selected.truncated) {
		const nextOffset = lastRange.endLine + 1;
		return [
			`[Showing lines ${selected.ranges[0]?.startLine ?? 1}-${lastRange.endLine} of ${lineCount}. Use offset=${nextOffset} to continue.]`,
		];
	}

	if (input.ranges === undefined && input.limit !== undefined && lastRange.endLine < lineCount) {
		const remaining = lineCount - lastRange.endLine;
		return [`[${remaining} more lines in file. Use offset=${lastRange.endLine + 1} to continue.]`];
	}

	return [];
}

function formatHeader(handle: string, path: string, ranges: ReturnedRange[]): string {
	return `${handle} ${path}:${formatReturnedRanges(ranges)}`;
}

function formatReturnedRanges(ranges: readonly ReturnedRange[]): string {
	return ranges.map((range) => `${range.startLine}-${range.endLine}`).join(",");
}

function formatRangeSuffix(input: ReadInput): string {
	if (input.ranges !== undefined) {
		return `:${input.ranges.map((range) => `${range.offset}-${range.offset + range.limit - 1}`).join(",")}`;
	}
	if (input.offset === undefined && input.limit === undefined) return "";
	const start = input.offset ?? 1;
	if (input.limit === undefined) return `:${start}-`;
	return `:${start}-${start + input.limit - 1}`;
}

function formatNumberedRanges(ranges: readonly SelectedRange[]): string {
	return ranges.map(formatNumberedRange).join(`\n\n${SEPARATOR}\n\n`);
}

function formatNumberedRange(range: SelectedRange): string {
	return range.lines.map((line) => `${line.lineNumber}| ${line.text}`).join("\n");
}

function renderUserText(value: string, theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1]): string {
	return value
		.split("\n")
		.map((line) => (line === SEPARATOR ? theme.fg("dim", line) : theme.fg("toolOutput", line)))
		.join("\n");
}

function isFileOperationsReadDetails(details: ReadDetails): details is FileOperationsReadDetails {
	return typeof details === "object" && details !== null && "kind" in details && details.kind === DETAILS_KIND;
}

function detectNewline(text: string): "lf" | "crlf" | "mixed" | "none" {
	const hasCrLf = text.includes("\r\n");
	const hasLf = /(^|[^\r])\n/.test(text);
	if (hasCrLf && hasLf) return "mixed";
	if (hasCrLf) return "crlf";
	if (hasLf) return "lf";
	return "none";
}

function isSupportedImage(buffer: Buffer): boolean {
	return isPng(buffer) || isJpeg(buffer) || isGif(buffer) || isWebp(buffer);
}

function isPng(buffer: Buffer): boolean {
	return (
		buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	);
}

function isJpeg(buffer: Buffer): boolean {
	return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isGif(buffer: Buffer): boolean {
	if (buffer.length < 6) return false;
	const header = buffer.subarray(0, 6).toString("ascii");
	return header === "GIF87a" || header === "GIF89a";
}

function isWebp(buffer: Buffer): boolean {
	return (
		buffer.length >= 12 &&
		buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
		buffer.subarray(8, 12).toString("ascii") === "WEBP"
	);
}
