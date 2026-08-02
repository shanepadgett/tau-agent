import { type LineRange, mergeLineRanges } from "../../shared/ranges.js";

export interface ChunkLine {
	prefix: " " | "+" | "-";
	text: string;
}

export interface UpdateFileChunk {
	changeContext?: string;
	lines: ChunkLine[];
	isEndOfFile: boolean;
}

export interface SnapshotRange extends LineRange {}

export interface ApplyChunksResult {
	content: string;
	snapshotRanges: SnapshotRange[];
}

interface TextParts {
	bom: string;
	text: string;
	lineEnding: "\n" | "\r\n";
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function detectLineEnding(content: string): "\n" | "\r\n" {
	const crlfIndex = content.indexOf("\r\n");
	const lfIndex = content.indexOf("\n");
	if (lfIndex === -1 || crlfIndex === -1) return "\n";
	return crlfIndex < lfIndex ? "\r\n" : "\n";
}

function normalizeToLf(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, lineEnding: "\n" | "\r\n"): string {
	return lineEnding === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function splitText(content: string): TextParts {
	const { bom, text } = stripBom(content);
	return {
		bom,
		text: normalizeToLf(text),
		lineEnding: detectLineEnding(text),
	};
}

function splitLogicalLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function countLogicalLines(content: string): number {
	return splitLogicalLines(normalizeToLf(stripBom(content).text)).length;
}

function normalizeUnicodeText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

function normalizeForFuzzyMatch(value: string): string {
	return normalizeUnicodeText(value).trimEnd();
}

function matchesAt(source: string[], pattern: string[], start: number, normalize: (value: string) => string): boolean {
	if (start < 0 || start + pattern.length > source.length) return false;
	for (let offset = 0; offset < pattern.length; offset += 1) {
		const sourceLine = source[start + offset];
		const patternLine = pattern[offset];
		if (sourceLine === undefined || patternLine === undefined) return false;
		if (normalize(sourceLine) !== normalize(patternLine)) return false;
	}
	return true;
}

const NORMALIZERS: ReadonlyArray<(value: string) => string> = [
	(value) => value,
	(value) => value.trimEnd(),
	(value) => value.trim(),
	normalizeForFuzzyMatch,
];

function findSequenceMatches(lines: string[], pattern: string[], start: number): number[] {
	if (pattern.length === 0) return [Math.min(Math.max(start, 0), lines.length)];
	for (const normalize of NORMALIZERS) {
		const matches: number[] = [];
		for (let index = Math.max(start, 0); index <= lines.length - pattern.length; index += 1) {
			if (matchesAt(lines, pattern, index, normalize)) matches.push(index);
		}
		if (matches.length > 0) return matches;
	}
	return [];
}

function seekSequence(lines: string[], pattern: string[], start: number): number {
	return findSequenceMatches(lines, pattern, start)[0] ?? -1;
}

function buildReplacement(chunk: UpdateFileChunk, fileLines: string[], matchIndex: number): string[] {
	const result: string[] = [];
	let fileOffset = 0;
	for (const line of chunk.lines) {
		if (line.prefix === "+") {
			result.push(line.text);
		} else if (line.prefix === "-") {
			fileOffset += 1;
		} else {
			result.push(fileLines[matchIndex + fileOffset] ?? line.text);
			fileOffset += 1;
		}
	}
	return result;
}

interface ChunkReplacement {
	index: number;
	deleteCount: number;
	insert: string[];
	order: number;
}

function seekChunkContext(
	lines: string[],
	chunk: UpdateFileChunk,
	lineIndex: number,
	chunkNumber: number,
	total: number,
): number {
	if (!chunk.changeContext) return lineIndex;
	const contextIndex = seekSequence(lines, [chunk.changeContext], lineIndex);
	if (contextIndex < 0) {
		throw new UpdateChunkApplyError(chunkNumber, total, formatContextHint(chunk), "could not find update context");
	}
	return contextIndex + 1;
}

function matchChunkIndex(
	lines: string[],
	chunk: UpdateFileChunk,
	oldLines: string[],
	lineIndex: number,
	chunkNumber: number,
	total: number,
): number {
	if (oldLines.length === 0) return lines.length;
	if (chunk.isEndOfFile) {
		const eofIndex = lines.length - oldLines.length;
		if (eofIndex >= lineIndex && seekSequence(lines, oldLines, eofIndex) === eofIndex) return eofIndex;
	}
	const matchIndex = seekSequence(lines, oldLines, lineIndex);
	if (matchIndex < 0) {
		throw new UpdateChunkApplyError(chunkNumber, total, formatContextHint(chunk), "could not match");
	}
	return matchIndex;
}

function planChunkReplacement(
	lines: string[],
	chunk: UpdateFileChunk,
	lineIndex: number,
	order: number,
	chunkNumber: number,
	total: number,
): {
	replacement: ChunkReplacement;
	nextLineIndex: number;
	rawRange: { index: number; deleteCount: number; insertCount: number };
} {
	const searchFrom = seekChunkContext(lines, chunk, lineIndex, chunkNumber, total);
	const oldLines = chunk.lines.filter((l) => l.prefix !== "+").map((l) => l.text);
	const matchIndex = matchChunkIndex(lines, chunk, oldLines, searchFrom, chunkNumber, total);
	const insert = oldLines.length === 0 ? chunk.lines.map((l) => l.text) : buildReplacement(chunk, lines, matchIndex);
	const deleteCount = oldLines.length;
	return {
		replacement: { index: matchIndex, deleteCount, insert, order },
		nextLineIndex: oldLines.length === 0 ? searchFrom : matchIndex + oldLines.length,
		rawRange: { index: matchIndex, deleteCount, insertCount: insert.length },
	};
}

function applyPlannedReplacements(lines: string[], replacements: ChunkReplacement[]): string[] {
	const output = [...lines];
	replacements
		.sort((a, b) => b.index - a.index || b.order - a.order)
		.forEach((r) => {
			output.splice(r.index, r.deleteCount, ...r.insert);
		});
	return output;
}

export function applyChunksWithRanges(currentContent: string, chunks: UpdateFileChunk[]): ApplyChunksResult {
	const parts = splitText(currentContent);
	const lines = splitLogicalLines(parts.text);
	const replacements: ChunkReplacement[] = [];
	const rawRanges: Array<{ index: number; deleteCount: number; insertCount: number }> = [];
	let lineIndex = 0;
	let order = 0;

	for (let ci = 0; ci < chunks.length; ci += 1) {
		const chunk = chunks[ci];
		if (chunk === undefined) continue;
		const planned = planChunkReplacement(lines, chunk, lineIndex, order, ci + 1, chunks.length);
		replacements.push(planned.replacement);
		rawRanges.push(planned.rawRange);
		lineIndex = planned.nextLineIndex;
		order += 1;
	}

	const output = applyPlannedReplacements(lines, replacements);
	const joined = output.join("\n");
	const normalized = joined === "" ? "" : `${joined}\n`;
	const next = parts.bom + restoreLineEndings(normalized, parts.lineEnding);
	return { content: next, snapshotRanges: mergeLineRanges(toPostApplyRanges(rawRanges, output.length)) };
}

function toPostApplyRanges(
	rawRanges: Array<{ index: number; deleteCount: number; insertCount: number }>,
	lineCount: number,
): SnapshotRange[] {
	const ranges: SnapshotRange[] = [];
	let delta = 0;
	for (const range of rawRanges) {
		const postIndex = range.index + delta;
		if (range.insertCount > 0) {
			const startLine = Math.max(1, postIndex + 1);
			const endLine = Math.min(lineCount, postIndex + range.insertCount);
			if (endLine >= startLine) ranges.push({ startLine, endLine });
		} else if (lineCount > 0) {
			const anchor = Math.min(Math.max(1, postIndex + 1), lineCount);
			ranges.push({ startLine: anchor, endLine: anchor });
		}
		delta += range.insertCount - range.deleteCount;
	}
	return ranges;
}

export class UpdateChunkApplyError extends Error {
	chunkIndex: number;
	totalChunks: number;
	contextHint?: string;

	constructor(chunkIndex: number, totalChunks: number, contextHint: string | undefined, message: string) {
		super(message);
		this.name = "UpdateChunkApplyError";
		this.chunkIndex = chunkIndex;
		this.totalChunks = totalChunks;
		this.contextHint = contextHint;
	}
}

function formatContextHint(chunk: UpdateFileChunk): string | undefined {
	const raw = chunk.changeContext ?? chunk.lines.find((l) => l.text.trim().length > 0)?.text;
	if (!raw) return undefined;
	const compact = raw.replace(/\s+/g, " ").trim();
	if (!compact) return undefined;
	return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}
