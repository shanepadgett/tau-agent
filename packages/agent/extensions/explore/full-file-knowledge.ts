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
