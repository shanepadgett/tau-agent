import type { ChunkLine, UpdateFileChunk } from "./matcher.ts";

type ParsedSection =
	| { type: "add"; path: string; content: string; linesAdded: number }
	| {
			type: "update";
			path: string;
			movePath?: string;
			chunks: UpdateFileChunk[];
			linesAdded: number;
			linesRemoved: number;
	  }
	| { type: "delete"; path: string };

export type PatchOperation =
	| { type: "add"; sectionIndex: number; path: string; content: string; linesAdded: number }
	| {
			type: "update";
			sectionIndex: number;
			path: string;
			movePath?: string;
			chunks: UpdateFileChunk[];
			linesAdded: number;
			linesRemoved: number;
	  }
	| { type: "delete"; sectionIndex: number; path: string };

export interface PatchFailure {
	phase: "parse" | "apply";
	sectionIndex: number;
	path?: string;
	kind?: PatchOperation["type"];
	chunkIndex?: number;
	totalChunks?: number;
	contextHint?: string;
	message: string;
}

export interface ParsedPatch {
	operations: PatchOperation[];
	parseFailures: PatchFailure[];
	totalSections: number;
}

const TOP_LEVEL_BOUNDARIES = [
	"*** End Patch",
	"*** Add File: ",
	"*** Replace File: ",
	"*** Delete File: ",
	"*** Update File: ",
] as const;

function isTopLevelBoundary(line: string): boolean {
	return TOP_LEVEL_BOUNDARIES.some((b) => (b === "*** End Patch" ? line === b : line.startsWith(b)));
}

function requirePath(line: string, prefix: string): string {
	const value = line.slice(prefix.length).trim();
	if (!value) throw new Error(`Missing path for patch directive: ${line}`);
	return value;
}

function parseAddBody(lines: string[], startIndex: number): { content: string; lineCount: number; nextIndex: number } {
	const body: string[] = [];
	let index = startIndex;
	while (index < lines.length && lines[index]!.startsWith("+")) {
		body.push(lines[index]!.slice(1));
		index += 1;
	}
	return {
		content: body.length === 0 ? "" : `${body.join("\n")}\n`,
		lineCount: body.length,
		nextIndex: index,
	};
}

interface MutableChunk {
	changeContext?: string;
	lines: ChunkLine[];
	isEndOfFile: boolean;
	hasLines: boolean;
}

function createChunk(changeContext?: string): MutableChunk {
	return { changeContext, lines: [], isEndOfFile: false, hasLines: false };
}

function finalizeChunk(target: MutableChunk | undefined, chunks: UpdateFileChunk[], path: string): void {
	if (!target) return;
	if (!target.hasLines) throw new Error(`Update file patch has an empty chunk: ${path}`);
	chunks.push({
		changeContext: target.changeContext,
		lines: target.lines,
		isEndOfFile: target.isEndOfFile,
	});
}

function parseChunkLine(rawLine: string): { prefix: " " | "+" | "-"; text: string } {
	if (rawLine.length === 0) return { prefix: " ", text: "" };
	const prefix = rawLine[0];
	if (prefix !== " " && prefix !== "+" && prefix !== "-") {
		throw new Error(`Invalid update hunk line: ${rawLine}`);
	}
	return { prefix, text: rawLine.slice(1) };
}

function parseUpdateBody(
	lines: string[],
	startIndex: number,
	operationPath: string,
): { movePath?: string; chunks: UpdateFileChunk[]; linesAdded: number; linesRemoved: number; nextIndex: number } {
	const chunks: UpdateFileChunk[] = [];
	let index = startIndex;
	let movePath: string | undefined;
	let current: MutableChunk | undefined;
	let sawAnyChunk = false;
	let linesAdded = 0;
	let linesRemoved = 0;

	while (index < lines.length) {
		const line = lines[index]!;
		if (isTopLevelBoundary(line)) break;

		if (line.startsWith("*** Move to: ")) {
			if (sawAnyChunk || current) throw new Error(`Move to must appear before update chunks: ${operationPath}`);
			movePath = requirePath(line, "*** Move to: ");
			index += 1;
			continue;
		}

		if (line.startsWith("@@")) {
			finalizeChunk(current, chunks, operationPath);
			const context = line.slice(2).trim();
			current = createChunk(context.length > 0 ? context : undefined);
			sawAnyChunk = true;
			index += 1;
			continue;
		}

		if (line === "*** End of File") {
			if (!current) {
				if (sawAnyChunk || chunks.length > 0) {
					throw new Error(`Only the first update chunk may omit @@: ${operationPath}`);
				}
				current = createChunk();
				sawAnyChunk = true;
			}
			current.isEndOfFile = true;
			index += 1;
			continue;
		}

		if (!current) {
			if (sawAnyChunk || chunks.length > 0) {
				throw new Error(`Only the first update chunk may omit @@: ${operationPath}`);
			}
			current = createChunk();
			sawAnyChunk = true;
		}

		const parsedLine = parseChunkLine(line);
		current.hasLines = true;

		if (parsedLine.prefix === "+") linesAdded += 1;
		if (parsedLine.prefix === "-") linesRemoved += 1;

		current.lines.push({ prefix: parsedLine.prefix, text: parsedLine.text });
		index += 1;
	}

	finalizeChunk(current, chunks, operationPath);
	if (chunks.length === 0 && !movePath)
		throw new Error(`Update file patch is missing chunk content: ${operationPath}`);

	return { movePath, chunks, linesAdded, linesRemoved, nextIndex: index };
}

function parseSection(sectionLines: string[]): ParsedSection {
	const header = sectionLines[0] ?? "";

	if (header.startsWith("*** Add File: ") || header.startsWith("*** Replace File: ")) {
		const prefix = header.startsWith("*** Add File: ") ? "*** Add File: " : "*** Replace File: ";
		const path = requirePath(header, prefix);
		const body = parseAddBody(sectionLines, 1);
		if (body.nextIndex !== sectionLines.length) throw new Error(`Malformed Add File section: ${path}`);
		return { type: "add", path, content: body.content, linesAdded: body.lineCount };
	}

	if (header.startsWith("*** Delete File: ")) {
		const path = requirePath(header, "*** Delete File: ");
		if (sectionLines.length !== 1) throw new Error(`Malformed Delete File section: ${path}`);
		return { type: "delete", path };
	}

	if (header.startsWith("*** Update File: ")) {
		const path = requirePath(header, "*** Update File: ");
		const updateBody = parseUpdateBody(sectionLines, 1, path);
		if (updateBody.nextIndex !== sectionLines.length) throw new Error(`Malformed Update File section: ${path}`);
		return {
			type: "update",
			path,
			movePath: updateBody.movePath,
			chunks: updateBody.chunks,
			linesAdded: updateBody.linesAdded,
			linesRemoved: updateBody.linesRemoved,
		};
	}

	throw new Error(`Unexpected patch line: ${header}`);
}

function parseHeaderMetadata(header: string): Pick<PatchFailure, "kind" | "path"> {
	if (header.startsWith("*** Add File: ") || header.startsWith("*** Replace File: ")) {
		return { kind: "add", path: header.slice(header.indexOf(": ") + 2).trim() || undefined };
	}
	if (header.startsWith("*** Delete File: ")) {
		return { kind: "delete", path: header.slice("*** Delete File: ".length).trim() || undefined };
	}
	if (header.startsWith("*** Update File: ")) {
		return { kind: "update", path: header.slice("*** Update File: ".length).trim() || undefined };
	}
	return {};
}

function envelopeFailure(message: string): ParsedPatch {
	return { operations: [], parseFailures: [{ phase: "parse", sectionIndex: 0, message }], totalSections: 1 };
}

export function parsePatch(input: string): ParsedPatch {
	const normalized = input.replace(/\r\n/g, "\n").trim();
	if (!normalized) return envelopeFailure("Patch must not be empty.");

	const lines = normalized.split("\n");
	if (lines[0] !== "*** Begin Patch") return envelopeFailure("Patch must start with exactly *** Begin Patch.");
	if (lines[lines.length - 1] !== "*** End Patch")
		return envelopeFailure("Patch must end with exactly *** End Patch.");

	const operations: PatchOperation[] = [];
	const parseFailures: PatchFailure[] = [];
	let index = 1;
	let sectionIndex = 0;

	while (index < lines.length - 1) {
		const line = lines[index]!;
		if (line.trim() === "") {
			index += 1;
			continue;
		}

		if (!isTopLevelBoundary(line) || line === "*** End Patch") {
			parseFailures.push({ phase: "parse", sectionIndex, message: `Unexpected patch line: ${line}` });
			index += 1;
			continue;
		}

		sectionIndex += 1;
		const sectionStart = index;
		let nextBoundary = index + 1;
		while (nextBoundary < lines.length && !isTopLevelBoundary(lines[nextBoundary]!)) nextBoundary += 1;

		const sectionLines = lines.slice(sectionStart, nextBoundary);
		try {
			operations.push({ ...parseSection(sectionLines), sectionIndex });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			parseFailures.push({
				phase: "parse",
				sectionIndex,
				...parseHeaderMetadata(sectionLines[0] ?? ""),
				message,
			});
		}

		index = nextBoundary;
	}

	if (operations.length === 0 && parseFailures.length === 0) {
		parseFailures.push({ phase: "parse", sectionIndex: 0, message: "Patch contains no operations." });
	}

	return {
		operations,
		parseFailures,
		totalSections: Math.max(sectionIndex, operations.length + parseFailures.length),
	};
}
