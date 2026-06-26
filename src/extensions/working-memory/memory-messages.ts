import { extname } from "node:path";

export const REREAD_CUSTOM_TYPE = "tau.working-memory.reread";
export const PATH_UPDATE_CUSTOM_TYPE = "tau.working-memory.path-update";

export interface RereadDetails {
	workingMemory: {
		version: 2;
		type: "reread";
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
	| { kind: "changed"; path: string; rereadSkipped: string };

export interface PathUpdateDetails {
	workingMemory: {
		version: 2;
		type: "path-update";
		source: "mutation";
		sourceToolCallId: string;
		changes: PathUpdateChange[];
	};
}

export function buildRereadMessage(options: {
	path: string;
	content: string;
	source: "mutation" | "tau-edit";
	sourceToolCallId?: string;
}): { content: string; details: RereadDetails } {
	const lineCount = splitLines(options.content).length;
	const byteLength = Buffer.byteLength(options.content);
	return {
		content: `reread ${options.path}\n\`\`\`${languageForPath(options.path)}\n${options.content}${options.content.endsWith("\n") ? "" : "\n"}\`\`\``,
		details: {
			workingMemory: {
				version: 2,
				type: "reread",
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
): {
	content: string;
	details: PathUpdateDetails;
} {
	return {
		content: `path update\n${changes.map(formatPathUpdateChange).join("\n")}`,
		details: {
			workingMemory: { version: 2, type: "path-update", source: "mutation", sourceToolCallId, changes },
		},
	};
}

export function parseRereadDetails(value: unknown): RereadDetails["workingMemory"] | undefined {
	if (!isRecord(value) || !isRecord(value.workingMemory)) return undefined;
	const wm = value.workingMemory;
	if (wm.version !== 2 || wm.type !== "reread") return undefined;
	if (wm.source !== "mutation" && wm.source !== "tau-edit") return undefined;
	if (typeof wm.path !== "string" || typeof wm.lineCount !== "number" || typeof wm.byteLength !== "number")
		return undefined;
	if (wm.sourceToolCallId !== undefined && typeof wm.sourceToolCallId !== "string") return undefined;
	return {
		version: 2,
		type: "reread",
		source: wm.source,
		path: wm.path,
		...(wm.sourceToolCallId ? { sourceToolCallId: wm.sourceToolCallId } : {}),
		lineCount: wm.lineCount,
		byteLength: wm.byteLength,
	};
}

export function parsePathUpdateDetails(value: unknown): PathUpdateDetails["workingMemory"] | undefined {
	if (!isRecord(value) || !isRecord(value.workingMemory)) return undefined;
	const wm = value.workingMemory;
	if (wm.version !== 2 || wm.type !== "path-update" || wm.source !== "mutation") return undefined;
	if (typeof wm.sourceToolCallId !== "string" || !Array.isArray(wm.changes)) return undefined;
	const changes = wm.changes.flatMap(parsePathUpdateChange);
	if (changes.length !== wm.changes.length) return undefined;
	return { version: 2, type: "path-update", source: "mutation", sourceToolCallId: wm.sourceToolCallId, changes };
}

function formatPathUpdateChange(change: PathUpdateChange): string {
	if (change.kind === "moved") return `- moved ${change.from} -> ${change.to}`;
	if (change.kind === "deleted") return `- deleted ${change.path}`;
	if (change.kind === "created") return `- created ${change.path}`;
	return `- changed ${change.path} (reread skipped: ${change.rereadSkipped})`;
}

export function splitLines(text: string): string[] {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function parsePathUpdateChange(value: unknown): PathUpdateChange[] {
	if (!isRecord(value) || typeof value.kind !== "string") return [];
	if (value.kind === "moved" && typeof value.from === "string" && typeof value.to === "string")
		return [{ kind: "moved", from: value.from, to: value.to }];
	if (value.kind === "deleted" && typeof value.path === "string") return [{ kind: "deleted", path: value.path }];
	if (value.kind === "created" && typeof value.path === "string") return [{ kind: "created", path: value.path }];
	if (value.kind === "changed" && typeof value.path === "string" && typeof value.rereadSkipped === "string")
		return [{ kind: "changed", path: value.path, rereadSkipped: value.rereadSkipped }];
	return [];
}

export function textContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return typeof content === "string" ? content : undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
		parts.push(block.text);
	}
	return parts.join("\n");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function languageForPath(path: string): string {
	const ext = extname(path).slice(1);
	return ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" || ext === "json" || ext === "md" ? ext : "";
}
