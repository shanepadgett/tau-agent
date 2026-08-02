import type { ChunkLine, UpdateFileChunk } from "./matcher.ts";

type ParsedSection =
	| { type: "add"; path: string; content: string; linesAdded: number }
	| { type: "replace"; path: string; content: string; linesAdded: number }
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
	| { type: "replace"; sectionIndex: number; path: string; content: string; linesAdded: number }
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

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const REPLACE_FILE_MARKER = "*** Replace File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const CHANGE_CONTEXT_MARKER = "@@";
const EOF_MARKER = "*** End of File";

const TOP_LEVEL_BOUNDARIES = [
	END_PATCH_MARKER,
	ADD_FILE_MARKER,
	REPLACE_FILE_MARKER,
	DELETE_FILE_MARKER,
	UPDATE_FILE_MARKER,
] as const;

function topLevelDirective(line: string): string {
	return line.trim();
}

function updateDirective(line: string): string {
	return line.trimEnd();
}

function isTopLevelBoundary(line: string): boolean {
	const value = topLevelDirective(line);
	return TOP_LEVEL_BOUNDARIES.some((b) => (b === END_PATCH_MARKER ? value === b : value.startsWith(b)));
}

function isUpdateBoundary(line: string): boolean {
	const value = updateDirective(line);
	return TOP_LEVEL_BOUNDARIES.some((b) => (b === END_PATCH_MARKER ? value === b : value.startsWith(b)));
}

function requirePathFromDirective(value: string, originalLine: string, prefix: string): string {
	const path = value.slice(prefix.length).trim();
	if (!path) throw new Error(`Missing path for patch directive: ${originalLine}`);
	return path;
}

function requireTopLevelPath(line: string, prefix: string): string {
	return requirePathFromDirective(topLevelDirective(line), line, prefix);
}

function requireUpdatePath(line: string, prefix: string): string {
	return requirePathFromDirective(updateDirective(line), line, prefix);
}

function isUpdateHeader(line: string): boolean {
	return topLevelDirective(line).startsWith(UPDATE_FILE_MARKER);
}

function nextSectionBoundary(lines: string[], start: number, updateBody: boolean): number {
	let index = start;
	const limit = lines.length - 1;
	while (index < limit) {
		const line = lines[index];
		if (line === undefined) break;
		if (updateBody ? isUpdateBoundary(line) : isTopLevelBoundary(line)) break;
		index += 1;
	}
	return index;
}

function parseAddBody(lines: string[], startIndex: number): { content: string; lineCount: number; nextIndex: number } {
	const body: string[] = [];
	let index = startIndex;
	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined || !line.startsWith("+")) break;
		body.push(line.slice(1));
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

interface UpdateBodyState {
	chunks: UpdateFileChunk[];
	index: number;
	movePath?: string;
	current?: MutableChunk;
	sawAnyChunk: boolean;
	linesAdded: number;
	linesRemoved: number;
}

function changeContextFromDirective(directive: string): string | undefined {
	if (directive === CHANGE_CONTEXT_MARKER) return undefined;
	const context = directive.slice(CHANGE_CONTEXT_MARKER.length + 1).trim();
	return context.length > 0 ? context : undefined;
}

function openOrReuseChunk(state: UpdateBodyState, operationPath: string): MutableChunk {
	if (state.current) return state.current;
	if (state.sawAnyChunk || state.chunks.length > 0) {
		throw new Error(`Only the first update chunk may omit @@: ${operationPath}`);
	}
	state.current = createChunk();
	state.sawAnyChunk = true;
	return state.current;
}

function appendHunkLine(state: UpdateBodyState, current: MutableChunk, line: string): void {
	const parsedLine = parseChunkLine(line);
	current.hasLines = true;
	if (parsedLine.prefix === "+") state.linesAdded += 1;
	if (parsedLine.prefix === "-") state.linesRemoved += 1;
	current.lines.push({ prefix: parsedLine.prefix, text: parsedLine.text });
	state.index += 1;
}

function consumeUpdateLine(state: UpdateBodyState, line: string, operationPath: string): boolean {
	const directive = updateDirective(line);
	if (isUpdateBoundary(line)) return false;

	if (directive.startsWith(MOVE_TO_MARKER)) {
		if (state.sawAnyChunk || state.current) {
			throw new Error(`Move to must appear before update chunks: ${operationPath}`);
		}
		state.movePath = requireUpdatePath(line, MOVE_TO_MARKER);
		state.index += 1;
		return true;
	}

	if (directive === CHANGE_CONTEXT_MARKER || directive.startsWith(`${CHANGE_CONTEXT_MARKER} `)) {
		finalizeChunk(state.current, state.chunks, operationPath);
		state.current = createChunk(changeContextFromDirective(directive));
		state.sawAnyChunk = true;
		state.index += 1;
		return true;
	}

	const current = openOrReuseChunk(state, operationPath);
	if (directive === EOF_MARKER) {
		current.isEndOfFile = true;
		state.index += 1;
		return true;
	}

	appendHunkLine(state, current, line);
	return true;
}

function parseUpdateBody(
	lines: string[],
	startIndex: number,
	operationPath: string,
): { movePath?: string; chunks: UpdateFileChunk[]; linesAdded: number; linesRemoved: number; nextIndex: number } {
	const state: UpdateBodyState = {
		chunks: [],
		index: startIndex,
		sawAnyChunk: false,
		linesAdded: 0,
		linesRemoved: 0,
	};

	while (state.index < lines.length) {
		const line = lines[state.index];
		if (line === undefined || !consumeUpdateLine(state, line, operationPath)) break;
	}

	finalizeChunk(state.current, state.chunks, operationPath);
	if (state.chunks.length === 0 && !state.movePath) {
		throw new Error(`Update file patch is missing chunk content: ${operationPath}`);
	}

	return {
		movePath: state.movePath,
		chunks: state.chunks,
		linesAdded: state.linesAdded,
		linesRemoved: state.linesRemoved,
		nextIndex: state.index,
	};
}

function parseWholeFileSection(header: string, sectionLines: string[], isReplace: boolean): ParsedSection {
	const prefix = isReplace ? REPLACE_FILE_MARKER : ADD_FILE_MARKER;
	const path = requireTopLevelPath(header, prefix);
	const body = parseAddBody(sectionLines, 1);
	if (body.nextIndex !== sectionLines.length) {
		throw new Error(`Malformed ${isReplace ? "Replace" : "Add"} File section: ${path}`);
	}
	return { type: isReplace ? "replace" : "add", path, content: body.content, linesAdded: body.lineCount };
}

function parseDeleteSection(header: string, sectionLines: string[]): ParsedSection {
	const path = requireTopLevelPath(header, DELETE_FILE_MARKER);
	if (sectionLines.length !== 1) throw new Error(`Malformed Delete File section: ${path}`);
	return { type: "delete", path };
}

function parseUpdateSection(header: string, sectionLines: string[]): ParsedSection {
	const path = requireTopLevelPath(header, UPDATE_FILE_MARKER);
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

function parseSection(sectionLines: string[]): ParsedSection {
	const header = sectionLines[0] ?? "";
	const headerDirective = topLevelDirective(header);

	if (headerDirective.startsWith(ADD_FILE_MARKER) || headerDirective.startsWith(REPLACE_FILE_MARKER)) {
		return parseWholeFileSection(header, sectionLines, headerDirective.startsWith(REPLACE_FILE_MARKER));
	}
	if (headerDirective.startsWith(DELETE_FILE_MARKER)) return parseDeleteSection(header, sectionLines);
	if (headerDirective.startsWith(UPDATE_FILE_MARKER)) return parseUpdateSection(header, sectionLines);
	throw new Error(`Unexpected patch line: ${header}`);
}

function parseHeaderMetadata(header: string): Pick<PatchFailure, "kind" | "path"> {
	const headerDirective = topLevelDirective(header);
	if (headerDirective.startsWith(ADD_FILE_MARKER) || headerDirective.startsWith(REPLACE_FILE_MARKER)) {
		return {
			kind: headerDirective.startsWith(REPLACE_FILE_MARKER) ? "replace" : "add",
			path: headerDirective.slice(headerDirective.indexOf(": ") + 2).trim() || undefined,
		};
	}
	if (headerDirective.startsWith(DELETE_FILE_MARKER)) {
		return { kind: "delete", path: headerDirective.slice(DELETE_FILE_MARKER.length).trim() || undefined };
	}
	if (headerDirective.startsWith(UPDATE_FILE_MARKER)) {
		return { kind: "update", path: headerDirective.slice(UPDATE_FILE_MARKER.length).trim() || undefined };
	}
	return {};
}

function envelopeFailure(message: string): ParsedPatch {
	return { operations: [], parseFailures: [{ phase: "parse", sectionIndex: 0, message }], totalSections: 1 };
}

function parseEnvelopeLines(input: string): string[] | ParsedPatch {
	const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (!normalized) return envelopeFailure("Patch must not be empty.");
	const lines = normalized.split("\n");
	if (topLevelDirective(lines[0] ?? "") !== BEGIN_PATCH_MARKER) {
		return envelopeFailure("Patch must start with *** Begin Patch.");
	}
	if (topLevelDirective(lines[lines.length - 1] ?? "") !== END_PATCH_MARKER) {
		return envelopeFailure("Patch must end with *** End Patch.");
	}
	return lines;
}

function pushParsedSection(
	operations: PatchOperation[],
	parseFailures: PatchFailure[],
	sectionIndex: number,
	sectionLines: string[],
): void {
	try {
		operations.push({ ...parseSection(sectionLines), sectionIndex });
	} catch (error) {
		parseFailures.push({
			phase: "parse",
			sectionIndex,
			...parseHeaderMetadata(sectionLines[0] ?? ""),
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export function parsePatch(input: string): ParsedPatch {
	const envelope = parseEnvelopeLines(input);
	if (!Array.isArray(envelope)) return envelope;
	const lines = envelope;

	const operations: PatchOperation[] = [];
	const parseFailures: PatchFailure[] = [];
	let index = 1;
	let sectionIndex = 0;

	while (index < lines.length - 1) {
		const line = lines[index];
		if (line === undefined) break;
		if (line.trim() === "") {
			index += 1;
			continue;
		}

		if (!isTopLevelBoundary(line) || topLevelDirective(line) === END_PATCH_MARKER) {
			parseFailures.push({ phase: "parse", sectionIndex, message: `Unexpected patch line: ${line}` });
			index += 1;
			continue;
		}

		sectionIndex += 1;
		const nextBoundary = nextSectionBoundary(lines, index + 1, isUpdateHeader(line));
		pushParsedSection(operations, parseFailures, sectionIndex, lines.slice(index, nextBoundary));
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
