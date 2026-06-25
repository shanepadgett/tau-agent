export interface ChunkLine {
	prefix: " " | "+" | "-";
	text: string;
}

export interface UpdateFileChunk {
	changeContext?: string;
	lines: ChunkLine[];
	isEndOfFile: boolean;
}

interface TextParts {
	bom: string;
	text: string;
	lineEnding: "\n" | "\r\n";
	hadTrailingNewline: boolean;
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
		hadTrailingNewline: text !== "" && /[\r\n]$/.test(text),
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
		if (normalize(source[start + offset]!) !== normalize(pattern[offset]!)) return false;
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

export function applyChunks(currentContent: string, chunks: UpdateFileChunk[]): string {
	const parts = splitText(currentContent);
	const lines = splitLogicalLines(parts.text);
	const replacements: Array<{ index: number; deleteCount: number; insert: string[] }> = [];
	let lineIndex = 0;

	for (let ci = 0; ci < chunks.length; ci += 1) {
		const chunk = chunks[ci]!;
		const oldLines = chunk.lines.filter((l) => l.prefix !== "+").map((l) => l.text);

		if (chunk.changeContext) {
			const contextIndex = seekSequence(lines, [chunk.changeContext], lineIndex);
			if (contextIndex < 0) {
				throw new UpdateChunkApplyError(
					ci + 1,
					chunks.length,
					formatContextHint(chunk),
					"could not find update context",
				);
			}
			lineIndex = contextIndex + 1;
		}

		if (oldLines.length === 0) {
			if (!chunk.changeContext && !chunk.isEndOfFile) {
				throw new UpdateChunkApplyError(
					ci + 1,
					chunks.length,
					formatContextHint(chunk),
					"pure insertion requires @@ anchor or *** End of File",
				);
			}
			const insertIndex = chunk.changeContext ? lineIndex : lines.length;
			replacements.push({ index: insertIndex, deleteCount: 0, insert: chunk.lines.map((l) => l.text) });
			lineIndex = insertIndex;
			continue;
		}

		let matchIndex = -1;
		if (chunk.isEndOfFile) {
			const eofIndex = lines.length - oldLines.length;
			if (eofIndex >= lineIndex && seekSequence(lines, oldLines, eofIndex) === eofIndex) {
				matchIndex = eofIndex;
			}
		} else if (!chunk.changeContext) {
			const matches = findSequenceMatches(lines, oldLines, lineIndex);
			if (matches.length > 1) {
				throw new UpdateChunkApplyError(
					ci + 1,
					chunks.length,
					formatContextHint(chunk),
					"ambiguous update match; add @@ anchor or more context",
				);
			}
			matchIndex = matches[0] ?? -1;
		}
		if (matchIndex < 0) matchIndex = seekSequence(lines, oldLines, lineIndex);
		if (matchIndex < 0) {
			throw new UpdateChunkApplyError(ci + 1, chunks.length, formatContextHint(chunk), "could not match");
		}

		const replacement = buildReplacement(chunk, lines, matchIndex);
		replacements.push({ index: matchIndex, deleteCount: oldLines.length, insert: replacement });
		lineIndex = matchIndex + oldLines.length;
	}

	const output = [...lines];
	replacements
		.sort((a, b) => b.index - a.index)
		.forEach((r) => {
			output.splice(r.index, r.deleteCount, ...r.insert);
		});

	const joined = output.join("\n");
	const normalized = parts.hadTrailingNewline && joined !== "" ? `${joined}\n` : joined;
	const next = parts.bom + restoreLineEndings(normalized, parts.lineEnding);
	if (next === currentContent) throw new Error("patch produced no changes");
	return next;
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
