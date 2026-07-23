import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const CONTEXT_PRUNE_TOOL = "context_prune";

export interface ContextPruneRefreshedFileV2 {
	path: string;
	rowId: string;
	servedHash: string;
	autoreadDetails: Record<string, unknown>;
}

export interface ContextPruneDeferredFileV2 {
	path: string;
	reason: string;
	relevantWhen: string;
}

export interface ContextPruneDetailsV2 {
	v: 2;
	anchorToolCallId: string;
	prunedToolCallIds: string[];
	prunedAutoreadRowIds: string[];
	retainedToolCallIds: string[];
	retainedAutoreadRowIds: string[];
	refreshedFiles: ContextPruneRefreshedFileV2[];
	deferredFiles: ContextPruneDeferredFileV2[];
	warnings: string[];
}

export interface ActiveContextPruningState {
	latestAnchorToolCallId: string | undefined;
	retainedToolCallIds: ReadonlySet<string>;
	prunedToolCallIds: ReadonlySet<string>;
	prunedAutoreadRowIds: ReadonlySet<string>;
	deferredFiles: readonly ContextPruneDeferredFileV2[];
}

const RUNTIME_ENABLED_KEY = Symbol.for("@earendil-works/tau-agent/context-pruning-enabled");
const runtimeState = globalThis as typeof globalThis & { [key: symbol]: unknown };

export function setContextPruningEnabled(enabled: boolean): void {
	runtimeState[RUNTIME_ENABLED_KEY] = enabled;
}

function isContextPruningEnabled(): boolean {
	return runtimeState[RUNTIME_ENABLED_KEY] === true;
}

export function parseContextPruneDetailsV2(value: unknown): ContextPruneDetailsV2 | undefined {
	if (!isRecord(value) || value.v !== 2 || !isNonEmptyString(value.anchorToolCallId)) return undefined;
	const prunedToolCallIds = parseUniqueStrings(value.prunedToolCallIds);
	const prunedAutoreadRowIds = parseUniqueStrings(value.prunedAutoreadRowIds);
	const retainedToolCallIds = parseUniqueStrings(value.retainedToolCallIds, true);
	const retainedAutoreadRowIds = parseUniqueStrings(value.retainedAutoreadRowIds);
	const refreshedFiles = parseRefreshedFiles(value.refreshedFiles);
	const deferredFiles = parseDeferredFiles(value.deferredFiles);
	const warnings = parseStrings(value.warnings, true);
	if (
		!prunedToolCallIds ||
		!prunedAutoreadRowIds ||
		!retainedToolCallIds ||
		!retainedAutoreadRowIds ||
		!refreshedFiles ||
		!deferredFiles ||
		!warnings
	)
		return undefined;
	return {
		v: 2,
		anchorToolCallId: value.anchorToolCallId,
		prunedToolCallIds,
		prunedAutoreadRowIds,
		retainedToolCallIds,
		retainedAutoreadRowIds,
		refreshedFiles,
		deferredFiles,
		warnings,
	};
}

export function replayContextPruningState(
	branch: readonly SessionEntry[],
	enabled = isContextPruningEnabled(),
): ActiveContextPruningState {
	const prunedToolCallIds = new Set<string>();
	const prunedAutoreadRowIds = new Set<string>();
	let latestAnchorToolCallId: string | undefined;
	let retainedToolCallIds = new Set<string>();
	let deferredFiles: readonly ContextPruneDeferredFileV2[] = [];
	if (enabled) {
		for (const entry of branch) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const result = entry.message;
			if (result.toolName !== CONTEXT_PRUNE_TOOL) continue;
			const details = parseContextPruneDetailsV2(result.details);
			if (!details || details.anchorToolCallId !== result.toolCallId) continue;
			for (const id of details.prunedToolCallIds) prunedToolCallIds.add(id);
			for (const id of details.prunedAutoreadRowIds) prunedAutoreadRowIds.add(id);
			latestAnchorToolCallId = details.anchorToolCallId;
			retainedToolCallIds = new Set(details.retainedToolCallIds);
			deferredFiles = details.deferredFiles;
		}
		for (const id of retainedToolCallIds) prunedToolCallIds.delete(id);
	}
	return {
		latestAnchorToolCallId,
		retainedToolCallIds,
		prunedToolCallIds,
		prunedAutoreadRowIds,
		deferredFiles,
	};
}

function parseRefreshedFiles(value: unknown): ContextPruneRefreshedFileV2[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const files: ContextPruneRefreshedFileV2[] = [];
	for (const item of value) {
		if (!isRecord(item) || !isNonEmptyString(item.path) || !isNonEmptyString(item.rowId)) return undefined;
		if (!isNonEmptyString(item.servedHash) || !isRecord(item.autoreadDetails)) return undefined;
		files.push({
			path: item.path,
			rowId: item.rowId,
			servedHash: item.servedHash,
			autoreadDetails: { ...item.autoreadDetails },
		});
	}
	return files;
}

function parseDeferredFiles(value: unknown): ContextPruneDeferredFileV2[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const files: ContextPruneDeferredFileV2[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.path !== "string" || typeof item.reason !== "string") return undefined;
		if (typeof item.relevantWhen !== "string") return undefined;
		files.push({ path: item.path, reason: item.reason, relevantWhen: item.relevantWhen });
	}
	return files;
}

function parseUniqueStrings(value: unknown, allowEmpty = false): string[] | undefined {
	const strings = parseStrings(value, allowEmpty);
	if (!strings || new Set(strings).size !== strings.length) return undefined;
	return strings;
}

function parseStrings(value: unknown, allowEmpty = false): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && (allowEmpty || item.length > 0))) {
		return undefined;
	}
	return [...value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
