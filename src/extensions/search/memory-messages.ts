import { extname } from "node:path";
import { isRecord, type SearchEvidenceDetails } from "./evidence.ts";

export const AUTO_READ_CUSTOM_TYPE = "tau.search.auto-read";
export const PATH_UPDATE_CUSTOM_TYPE = "tau.search.path-update";

export interface AutoReadDetails extends SearchEvidenceDetails {
	searchMemory: {
		version: 1;
		type: "auto-read";
		source: "mutation" | "tau-edit";
		path: string;
		sourceToolCallId?: string;
		lineCount: number;
		byteLength: number;
	};
}

export type PathUpdateChange =
	| { kind: "moved"; from: string; to: string }
	| { kind: "deleted"; path: string }
	| { kind: "created"; path: string }
	| { kind: "changed"; path: string; autoReadSkipped: string };

export interface PathUpdateDetails extends SearchEvidenceDetails {
	searchMemory: {
		version: 1;
		type: "path-update";
		source: "mutation";
		sourceToolCallId: string;
		changes: PathUpdateChange[];
	};
}

export function buildAutoReadMessage(options: {
	path: string;
	content: string;
	source: "mutation" | "tau-edit";
	sourceToolCallId?: string;
}): { content: string; details: AutoReadDetails } {
	const lineCount = splitLines(options.content).length;
	const byteLength = Buffer.byteLength(options.content);
	return {
		content: `auto read ${options.path}\n\`\`\`${languageForPath(options.path)}\n${options.content}${options.content.endsWith("\n") ? "" : "\n"}\`\`\``,
		details: {
			searchEvidence: {
				version: 1,
				kind: "auto-read",
				role: "current",
				paths: [options.path],
				complete: true,
				...(options.sourceToolCallId ? { toolCallId: options.sourceToolCallId } : {}),
			},
			searchMemory: {
				version: 1,
				type: "auto-read",
				source: options.source,
				path: options.path,
				...(options.sourceToolCallId ? { sourceToolCallId: options.sourceToolCallId } : {}),
				lineCount,
				byteLength,
			},
		},
	};
}

export function buildPathUpdateMessage(
	sourceToolCallId: string,
	changes: PathUpdateChange[],
): { content: string; details: PathUpdateDetails } {
	const paths = changes.flatMap((change) => (change.kind === "moved" ? [change.from, change.to] : [change.path]));
	return {
		content: `path update\n${changes.map(formatPathUpdateChange).join("\n")}`,
		details: {
			searchEvidence: {
				version: 1,
				kind: "path-update",
				role: "mutation",
				paths,
				complete: true,
				toolCallId: sourceToolCallId,
			},
			searchMemory: { version: 1, type: "path-update", source: "mutation", sourceToolCallId, changes },
		},
	};
}

export function parseAutoReadDetails(value: unknown): AutoReadDetails["searchMemory"] | undefined {
	if (!isRecord(value) || !isRecord(value.searchMemory)) return undefined;
	const memory = value.searchMemory;
	if (memory.version !== 1 || memory.type !== "auto-read") return undefined;
	if (memory.source !== "mutation" && memory.source !== "tau-edit") return undefined;
	if (typeof memory.path !== "string" || typeof memory.lineCount !== "number" || typeof memory.byteLength !== "number")
		return undefined;
	if (memory.sourceToolCallId !== undefined && typeof memory.sourceToolCallId !== "string") return undefined;
	return {
		version: 1,
		type: "auto-read",
		source: memory.source,
		path: memory.path,
		...(memory.sourceToolCallId ? { sourceToolCallId: memory.sourceToolCallId } : {}),
		lineCount: memory.lineCount,
		byteLength: memory.byteLength,
	};
}

export function parsePathUpdateDetails(value: unknown): PathUpdateDetails["searchMemory"] | undefined {
	if (!isRecord(value) || !isRecord(value.searchMemory)) return undefined;
	const memory = value.searchMemory;
	if (memory.version !== 1 || memory.type !== "path-update" || memory.source !== "mutation") return undefined;
	if (typeof memory.sourceToolCallId !== "string" || !Array.isArray(memory.changes)) return undefined;
	const changes = memory.changes.flatMap(parsePathUpdateChange);
	if (changes.length !== memory.changes.length) return undefined;
	return { version: 1, type: "path-update", source: "mutation", sourceToolCallId: memory.sourceToolCallId, changes };
}

function splitLines(text: string): string[] {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function textContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
		parts.push(block.text);
	}
	return parts.join("\n");
}

function formatPathUpdateChange(change: PathUpdateChange): string {
	if (change.kind === "moved") return `- moved ${change.from} -> ${change.to}`;
	if (change.kind === "deleted") return `- deleted ${change.path}`;
	if (change.kind === "created") return `- created ${change.path}`;
	return `- changed ${change.path} (auto read skipped: ${change.autoReadSkipped})`;
}

function parsePathUpdateChange(value: unknown): PathUpdateChange[] {
	if (!isRecord(value) || typeof value.kind !== "string") return [];
	if (value.kind === "moved" && typeof value.from === "string" && typeof value.to === "string")
		return [{ kind: "moved", from: value.from, to: value.to }];
	if (value.kind === "deleted" && typeof value.path === "string") return [{ kind: "deleted", path: value.path }];
	if (value.kind === "created" && typeof value.path === "string") return [{ kind: "created", path: value.path }];
	if (value.kind === "changed" && typeof value.path === "string" && typeof value.autoReadSkipped === "string")
		return [{ kind: "changed", path: value.path, autoReadSkipped: value.autoReadSkipped }];
	return [];
}

function languageForPath(path: string): string {
	const ext = extname(path).slice(1);
	return ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" || ext === "json" || ext === "md" ? ext : "";
}
