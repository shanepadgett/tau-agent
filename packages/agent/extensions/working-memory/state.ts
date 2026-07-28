import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const WORKING_MEMORY_TOOL = "working_memory";

export interface DeferredFile {
	path: string;
	reason: string;
	relevantWhen: string;
}

export interface RetainedLabel {
	ref: string;
	label: string;
	preview: string;
}

export interface WorkingMemoryCheckpointDetailsV2 {
	v: 2;
	anchorToolCallId: string;
	retainedRefs: string[];
	retainedLabels: RetainedLabel[];
	prunedRowIds: string[];
	readFiles: string[];
	outlinedFiles: Array<{ path: string; rowId: string }>;
	deferredFiles: DeferredFile[];
	removedUnits: number;
	warnings: string[];
}

export interface ActiveWorkingMemoryState {
	latestAnchorToolCallId: string | undefined;
	retainedRefs: readonly string[];
	prunedRowIds: ReadonlySet<string>;
}

export function parseWorkingMemoryDetails(value: unknown): WorkingMemoryCheckpointDetailsV2 | undefined {
	if (!isRecord(value) || value.v !== 2 || !nonempty(value.anchorToolCallId)) return undefined;
	const keys = [
		"v",
		"anchorToolCallId",
		"retainedRefs",
		"retainedLabels",
		"prunedRowIds",
		"readFiles",
		"outlinedFiles",
		"deferredFiles",
		"removedUnits",
		"warnings",
	];
	if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return undefined;
	const retainedRefs = uniqueStrings(value.retainedRefs);
	const prunedRowIds = uniqueStrings(value.prunedRowIds);
	const readFiles = uniqueStrings(value.readFiles);
	const warnings = strings(value.warnings);
	const retainedLabels = parseRetainedLabels(value.retainedLabels);
	const outlinedFiles = parseOutlinedFiles(value.outlinedFiles);
	const deferredFiles = parseDeferredFiles(value.deferredFiles);
	if (
		!retainedRefs ||
		!prunedRowIds ||
		!readFiles ||
		!warnings ||
		!retainedLabels ||
		retainedLabels.length !== retainedRefs.length ||
		retainedLabels.some((label, index) => label.ref !== retainedRefs[index]) ||
		!outlinedFiles ||
		!deferredFiles ||
		!Number.isSafeInteger(value.removedUnits) ||
		(value.removedUnits as number) < 0
	) {
		return undefined;
	}
	return {
		v: 2,
		anchorToolCallId: value.anchorToolCallId,
		retainedRefs,
		retainedLabels,
		prunedRowIds,
		readFiles,
		outlinedFiles,
		deferredFiles,
		removedUnits: value.removedUnits as number,
		warnings,
	};
}

export function replayWorkingMemoryState(branch: readonly SessionEntry[], enabled: boolean): ActiveWorkingMemoryState {
	let prunedRowIds = new Set<string>();
	let latestAnchorToolCallId: string | undefined;
	let retainedRefs: readonly string[] = [];
	if (enabled) {
		for (const entry of branch) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			if (entry.message.toolName !== WORKING_MEMORY_TOOL) continue;
			const details = parseWorkingMemoryDetails(entry.message.details);
			if (!details || details.anchorToolCallId !== entry.message.toolCallId) continue;
			prunedRowIds = new Set(details.prunedRowIds);
			latestAnchorToolCallId = details.anchorToolCallId;
			retainedRefs = details.retainedRefs;
		}
	}
	return { latestAnchorToolCallId, retainedRefs, prunedRowIds };
}

function parseRetainedLabels(value: unknown): RetainedLabel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const labels: RetainedLabel[] = [];
	for (const item of value) {
		if (!isRecord(item) || !nonempty(item.ref) || !nonempty(item.label) || typeof item.preview !== "string") {
			return undefined;
		}
		labels.push({ ref: item.ref, label: item.label, preview: item.preview });
	}
	return labels;
}

function parseOutlinedFiles(value: unknown): Array<{ path: string; rowId: string }> | undefined {
	if (!Array.isArray(value)) return undefined;
	const files: Array<{ path: string; rowId: string }> = [];
	for (const item of value) {
		if (!isRecord(item) || !nonempty(item.path) || !nonempty(item.rowId)) return undefined;
		files.push({ path: item.path, rowId: item.rowId });
	}
	return files;
}

function parseDeferredFiles(value: unknown): DeferredFile[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const files: DeferredFile[] = [];
	for (const item of value) {
		if (!isRecord(item) || !nonempty(item.path) || !nonempty(item.reason) || !nonempty(item.relevantWhen)) {
			return undefined;
		}
		files.push({ path: item.path, reason: item.reason, relevantWhen: item.relevantWhen });
	}
	return files;
}

function uniqueStrings(value: unknown): string[] | undefined {
	const parsed = strings(value, true);
	if (!parsed || new Set(parsed).size !== parsed.length) return undefined;
	return parsed;
}

function strings(value: unknown, requireNonempty = false): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (!value.every((item) => typeof item === "string" && (!requireNonempty || item.length > 0))) return undefined;
	return [...value];
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
