import { createHash } from "node:crypto";
import { generateUnifiedPatch, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ReadCacheMetaV1, ReadCacheMode, ReadCachePresentation } from "./read-cache.ts";

export const COMPLETE_FILE_SCOPE = "full";
export const MAX_COMPLETE_FILE_SNAPSHOT_BYTES = 1024 * 1024;

export interface CompleteFileSelection {
	text: string;
	mode: ReadCacheMode;
	summary: string;
}

export function createCompleteFileMeta(options: {
	pathKey: string;
	presentation: ReadCachePresentation;
	servedHash: string;
	mode: ReadCacheMode;
	sourceText: string;
	returnedText: string;
	totalLines: number;
	summary: string;
	baseHash?: string;
}): ReadCacheMetaV1 {
	return {
		v: 1,
		pathKey: options.pathKey,
		scopeKey: COMPLETE_FILE_SCOPE,
		presentation: options.presentation,
		servedHash: options.servedHash,
		baseHash: options.baseHash,
		mode: options.mode,
		baselineTokens: estimateTokens(options.sourceText),
		returnedTokens: estimateTokens(options.returnedText),
		totalLines: options.totalLines,
		summary: options.summary,
	};
}

export function readScopeKey(
	completeFile: boolean,
	startLine: number,
	endLine: number,
	presentation: ReadCachePresentation,
): string {
	return completeFile ? COMPLETE_FILE_SCOPE : `r:${startLine}:${endLine}:n${presentation === "line-numbered" ? 1 : 0}`;
}

export function decodeCompleteFileSource(options: {
	content: unknown;
	autoread: boolean;
	pathHeader?: string;
	presentation: ReadCachePresentation;
	servedHash: string;
}): { valid: boolean; text?: string } {
	const payload = textContent(options.content);
	if (payload === undefined) return { valid: false };
	const separator = payload.indexOf("\n");
	if (
		options.autoread &&
		(separator < 0 || options.pathHeader === undefined || payload.slice(0, separator) !== options.pathHeader)
	)
		return { valid: false };
	const body = options.autoread ? payload.slice(separator + 1) : payload;
	const text = options.presentation === "plain" ? body : decodeLineNumbers(body);
	if (text === undefined) return { valid: false };
	const bytes = Buffer.byteLength(text, "utf8");
	if (createHash("sha256").update(text, "utf8").digest("hex") !== options.servedHash) return { valid: false };
	return bytes <= MAX_COMPLETE_FILE_SNAPSHOT_BYTES ? { valid: true, text } : { valid: true };
}

export function applyCompleteFileDiff(options: {
	content: unknown;
	baseText: string;
	baseHash: string;
	servedHash: string;
}): { valid: boolean; text?: string } {
	if (hashText(options.baseText) !== options.baseHash) return { valid: false };
	const payload = textContent(options.content);
	if (payload === undefined) return { valid: false };
	const separator = payload.indexOf("\n");
	if (separator < 0 || !/^\[read: \d+ lines added, \d+ removed of \d+\]$/.test(payload.slice(0, separator))) {
		return { valid: false };
	}
	const text = applyUnifiedDiff(options.baseText, payload.slice(separator + 1));
	if (text === undefined || hashText(text) !== options.servedHash) return { valid: false };
	return Buffer.byteLength(text, "utf8") <= MAX_COMPLETE_FILE_SNAPSHOT_BYTES ? { valid: true, text } : { valid: true };
}

export function selectCompleteFileResponse(options: {
	displayPath: string;
	currentText: string;
	currentHash: string;
	fullText: string;
	totalLines: number;
	recovery: boolean;
	baseHash?: string;
	baselineText?: string;
}): CompleteFileSelection {
	if (options.recovery) return { text: options.fullText, mode: "recovery", summary: `${options.totalLines} lines` };
	if (!options.baseHash) return { text: options.fullText, mode: "baseline", summary: `${options.totalLines} lines` };
	if (options.baseHash === options.currentHash) {
		const text = `unchanged, ${options.totalLines} lines`;
		return { text, mode: "unchanged", summary: text };
	}
	if (options.baselineText !== undefined) {
		const patch = generateUnifiedPatch(options.displayPath, options.baselineText, options.currentText, 3);
		const counts = countDiffLines(patch);
		const candidate = `[read: ${counts.added} lines added, ${counts.removed} removed of ${options.totalLines}]\n${patch}`;
		if (!truncateHead(candidate).truncated && estimateTokens(candidate) < estimateTokens(options.fullText)) {
			return { text: candidate, mode: "diff", summary: `+${counts.added} -${counts.removed}` };
		}
	}
	return { text: options.fullText, mode: "baseline", summary: `${options.totalLines} lines` };
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function textContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const part = content[0];
	if (!part || typeof part !== "object") return undefined;
	const record = part as Record<string, unknown>;
	return record.type === "text" && typeof record.text === "string" ? record.text : undefined;
}

function applyUnifiedDiff(source: string, patch: string): string | undefined {
	const patchLines = patch.split("\n");
	const oldHeaderIndex = patchLines.findIndex(
		(line, index) => line.startsWith("--- ") && patchLines[index + 1]?.startsWith("+++ "),
	);
	if (oldHeaderIndex < 0) return undefined;
	const sourceEndsWithNewline = source.endsWith("\n");
	const sourceLines = source === "" ? [] : source.split("\n");
	if (sourceEndsWithNewline) sourceLines.pop();
	const output: string[] = [];
	let sourceIndex = 0;
	let patchIndex = oldHeaderIndex + 2;
	let hunkCount = 0;
	let outputEndsWithNewline = sourceEndsWithNewline;

	while (patchIndex < patchLines.length) {
		const header = patchLines[patchIndex];
		if (header === "" && patchIndex === patchLines.length - 1) break;
		if (header === undefined) return undefined;
		const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(header);
		if (!match) return undefined;
		const oldStartValue = Number(match[1]);
		const oldCount = match[2] === undefined ? 1 : Number(match[2]);
		const newCount = match[4] === undefined ? 1 : Number(match[4]);
		if (!Number.isSafeInteger(oldStartValue) || !Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newCount)) {
			return undefined;
		}
		const oldStart = oldCount === 0 ? oldStartValue : oldStartValue - 1;
		if (oldStart < sourceIndex || oldStart > sourceLines.length) return undefined;
		output.push(...sourceLines.slice(sourceIndex, oldStart));
		sourceIndex = oldStart;
		patchIndex += 1;
		let consumedOld = 0;
		let producedNew = 0;
		let previousMarker: string | undefined;
		let newSideHasNoFinalNewline = false;

		while (patchIndex < patchLines.length && !patchLines[patchIndex]?.startsWith("@@ ")) {
			const line = patchLines[patchIndex];
			if (line === "" && patchIndex === patchLines.length - 1) break;
			if (line === undefined) return undefined;
			if (line === "\\ No newline at end of file") {
				if (previousMarker !== "+" && previousMarker !== "-" && previousMarker !== " ") return undefined;
				if (previousMarker === "+" || previousMarker === " ") newSideHasNoFinalNewline = true;
				patchIndex += 1;
				continue;
			}
			const marker = line[0];
			const value = line.slice(1);
			if (marker === " ") {
				if (sourceLines[sourceIndex] !== value) return undefined;
				output.push(value);
				sourceIndex += 1;
				consumedOld += 1;
				producedNew += 1;
			} else if (marker === "-") {
				if (sourceLines[sourceIndex] !== value) return undefined;
				sourceIndex += 1;
				consumedOld += 1;
			} else if (marker === "+") {
				output.push(value);
				producedNew += 1;
			} else {
				return undefined;
			}
			previousMarker = marker;
			patchIndex += 1;
		}
		if (consumedOld !== oldCount || producedNew !== newCount) return undefined;
		if (sourceIndex === sourceLines.length) {
			outputEndsWithNewline = newCount > 0 && !newSideHasNoFinalNewline;
		}
		hunkCount += 1;
	}
	if (hunkCount === 0) return undefined;
	output.push(...sourceLines.slice(sourceIndex));
	const text = output.join("\n");
	return outputEndsWithNewline && output.length > 0 ? `${text}\n` : text;
}

function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function decodeLineNumbers(content: string): string | undefined {
	const lines = content.split("\n");
	const decoded: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const prefix = `${index + 1}: `;
		const line = lines[index];
		if (line === undefined || !line.startsWith(prefix)) return undefined;
		decoded.push(line.slice(prefix.length));
	}
	return decoded.join("\n");
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
