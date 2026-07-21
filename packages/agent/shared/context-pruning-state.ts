import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const CONTEXT_PRUNE_TOOL = "context_prune";
const AUTOREAD_MESSAGE_TYPE = "tau.autoread";

export interface ContextPruneRefreshedFileV1 {
	path: string;
	rowId: string;
	servedHash: string;
}

export interface ContextPruneDeferredFileV1 {
	path: string;
	reason: string;
	relevantWhen: string;
}

export interface ContextPruneDetailsV1 {
	v: 1;
	status: "applied" | "skipped";
	anchorToolCallId: string;
	newlyPrunedToolCallIds: string[];
	newlyPrunedAutoreadRowIds: string[];
	retainedToolCallIds: string[];
	retainedAutoreadRowIds: string[];
	refreshedFiles: ContextPruneRefreshedFileV1[];
	deferredFiles: ContextPruneDeferredFileV1[];
	tokensBefore: number;
	tokensAfter: number;
	tokensReclaimed: number;
}

export interface ActiveContextPruningState {
	latestAnchorToolCallId: string | undefined;
	prunedToolCallIds: ReadonlySet<string>;
	prunedAutoreadRowIds: ReadonlySet<string>;
	deferredFiles: readonly ContextPruneDeferredFileV1[];
}

const RUNTIME_ENABLED_KEY = Symbol.for("@earendil-works/tau-agent/context-pruning-enabled");
const runtimeState = globalThis as typeof globalThis & { [key: symbol]: unknown };

export function setContextPruningEnabled(enabled: boolean): void {
	runtimeState[RUNTIME_ENABLED_KEY] = enabled;
}

function isContextPruningEnabled(): boolean {
	return runtimeState[RUNTIME_ENABLED_KEY] === true;
}

export function parseContextPruneDetailsV1(value: unknown): ContextPruneDetailsV1 | undefined {
	if (
		!hasExactKeys(value, [
			"v",
			"status",
			"anchorToolCallId",
			"newlyPrunedToolCallIds",
			"newlyPrunedAutoreadRowIds",
			"retainedToolCallIds",
			"retainedAutoreadRowIds",
			"refreshedFiles",
			"deferredFiles",
			"tokensBefore",
			"tokensAfter",
			"tokensReclaimed",
		])
	)
		return undefined;
	if (value.v !== 1 || (value.status !== "applied" && value.status !== "skipped")) return undefined;
	if (!isNonEmptyString(value.anchorToolCallId)) return undefined;

	const newlyPrunedToolCallIds = parseUniqueStrings(value.newlyPrunedToolCallIds);
	const newlyPrunedAutoreadRowIds = parseUniqueStrings(value.newlyPrunedAutoreadRowIds);
	const retainedToolCallIds = parseUniqueStrings(value.retainedToolCallIds);
	const retainedAutoreadRowIds = parseUniqueStrings(value.retainedAutoreadRowIds);
	const refreshedFiles = parseRefreshedFiles(value.refreshedFiles);
	const deferredFiles = parseDeferredFiles(value.deferredFiles);
	if (
		!newlyPrunedToolCallIds ||
		!newlyPrunedAutoreadRowIds ||
		!retainedToolCallIds ||
		!retainedAutoreadRowIds ||
		!refreshedFiles ||
		!deferredFiles
	)
		return undefined;
	if (
		!isNonNegativeFinite(value.tokensBefore) ||
		!isNonNegativeFinite(value.tokensAfter) ||
		!isFiniteNumber(value.tokensReclaimed) ||
		value.tokensBefore - value.tokensAfter !== value.tokensReclaimed
	)
		return undefined;
	if (hasOverlap(newlyPrunedToolCallIds, retainedToolCallIds)) return undefined;
	if (hasOverlap(newlyPrunedAutoreadRowIds, retainedAutoreadRowIds)) return undefined;
	if (value.status === "skipped" && (newlyPrunedToolCallIds.length > 0 || newlyPrunedAutoreadRowIds.length > 0))
		return undefined;

	return {
		v: 1,
		status: value.status,
		anchorToolCallId: value.anchorToolCallId,
		newlyPrunedToolCallIds,
		newlyPrunedAutoreadRowIds,
		retainedToolCallIds,
		retainedAutoreadRowIds,
		refreshedFiles,
		deferredFiles,
		tokensBefore: value.tokensBefore,
		tokensAfter: value.tokensAfter,
		tokensReclaimed: value.tokensReclaimed,
	};
}

export function replayContextPruningState(
	branch: readonly SessionEntry[],
	enabled = isContextPruningEnabled(),
): ActiveContextPruningState {
	const prunedToolCallIds = new Set<string>();
	const prunedAutoreadRowIds = new Set<string>();
	const state: ActiveContextPruningState = {
		latestAnchorToolCallId: undefined,
		prunedToolCallIds,
		prunedAutoreadRowIds,
		deferredFiles: [],
	};
	if (!enabled) return state;

	const toolCalls = new Map<string, { count: number; name: string; index: number }>();
	const toolResults = new Map<string, { count: number; name: string; index: number }>();
	const autoreads = new Map<
		string,
		{ count: number; path: string; servedHash: string; source: string; batchId: string; index: number }
	>();
	for (let index = 0; index < branch.length; index += 1) {
		const entry = branch[index];
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const current = toolCalls.get(block.id);
					toolCalls.set(block.id, { count: (current?.count ?? 0) + 1, name: block.name, index });
				}
			} else if (message.role === "toolResult") {
				const current = toolResults.get(message.toolCallId);
				toolResults.set(message.toolCallId, {
					count: (current?.count ?? 0) + 1,
					name: message.toolName,
					index,
				});
			}
			continue;
		}
		if (entry.type !== "custom_message" || entry.customType !== AUTOREAD_MESSAGE_TYPE) continue;
		const autoread = parseAutoreadReference(entry.details);
		if (!autoread) continue;
		const current = autoreads.get(autoread.rowId);
		autoreads.set(autoread.rowId, {
			count: (current?.count ?? 0) + 1,
			path: autoread.path,
			servedHash: autoread.servedHash,
			source: autoread.source,
			batchId: autoread.batchId,
			index,
		});
	}

	for (let resultIndex = 0; resultIndex < branch.length; resultIndex += 1) {
		const entry = branch[resultIndex];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const result = entry.message;
		if (result.toolName !== CONTEXT_PRUNE_TOOL) continue;
		const details = parseContextPruneDetailsV1(result.details);
		if (!details || details.status !== "applied" || details.anchorToolCallId !== result.toolCallId) continue;
		if (!isCompleteExchange(details.anchorToolCallId, CONTEXT_PRUNE_TOOL, toolCalls, toolResults)) continue;
		const anchorCallIndex = toolCalls.get(details.anchorToolCallId)?.index;
		if (anchorCallIndex === undefined || anchorCallIndex >= resultIndex) continue;
		if (details.newlyPrunedToolCallIds.includes(details.anchorToolCallId)) continue;
		if (details.retainedToolCallIds.includes(details.anchorToolCallId)) continue;
		if (
			!allCompleteExchanges(details.newlyPrunedToolCallIds, toolCalls, toolResults) ||
			!allCompleteExchanges(details.retainedToolCallIds, toolCalls, toolResults) ||
			!allAutoreads(details.newlyPrunedAutoreadRowIds, autoreads) ||
			!allAutoreads(details.retainedAutoreadRowIds, autoreads)
		)
			continue;
		if (
			details.newlyPrunedToolCallIds.some((id) => !exchangePrecedes(id, anchorCallIndex, toolCalls, toolResults)) ||
			details.retainedToolCallIds.some((id) => !exchangePrecedes(id, anchorCallIndex, toolCalls, toolResults)) ||
			details.newlyPrunedAutoreadRowIds.some((id) => {
				const row = autoreads.get(id);
				return row === undefined || row.index >= anchorCallIndex;
			})
		)
			continue;
		if (
			details.newlyPrunedToolCallIds.some((id) => prunedToolCallIds.has(id)) ||
			details.retainedToolCallIds.some((id) => prunedToolCallIds.has(id)) ||
			details.newlyPrunedAutoreadRowIds.some((id) => prunedAutoreadRowIds.has(id)) ||
			details.retainedAutoreadRowIds.some((id) => prunedAutoreadRowIds.has(id))
		)
			continue;
		if (
			details.refreshedFiles.some((file) => {
				const row = autoreads.get(file.rowId);
				return (
					row?.count !== 1 ||
					row.path !== file.path ||
					row.servedHash !== file.servedHash ||
					row.source !== "context-pruning" ||
					row.batchId !== details.anchorToolCallId ||
					!details.retainedAutoreadRowIds.includes(file.rowId)
				);
			})
		)
			continue;
		const refreshedRowIds = new Set(details.refreshedFiles.map((file) => file.rowId));
		if (
			details.retainedAutoreadRowIds.some((id) => {
				const row = autoreads.get(id);
				return row === undefined || (row.index >= anchorCallIndex && !refreshedRowIds.has(id));
			})
		)
			continue;

		for (const id of details.newlyPrunedToolCallIds) prunedToolCallIds.add(id);
		for (const id of details.newlyPrunedAutoreadRowIds) prunedAutoreadRowIds.add(id);
		state.latestAnchorToolCallId = details.anchorToolCallId;
		state.deferredFiles = details.deferredFiles;
	}
	return state;
}

function parseRefreshedFiles(value: unknown): ContextPruneRefreshedFileV1[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const files: ContextPruneRefreshedFileV1[] = [];
	const rowIds = new Set<string>();
	for (const item of value) {
		if (!hasExactKeys(item, ["path", "rowId", "servedHash"])) return undefined;
		if (!isNonEmptyString(item.path) || !isNonEmptyString(item.rowId) || !isNonEmptyString(item.servedHash))
			return undefined;
		if (rowIds.has(item.rowId)) return undefined;
		rowIds.add(item.rowId);
		files.push({ path: item.path, rowId: item.rowId, servedHash: item.servedHash });
	}
	return files;
}

function parseDeferredFiles(value: unknown): ContextPruneDeferredFileV1[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const files: ContextPruneDeferredFileV1[] = [];
	for (const item of value) {
		if (!hasExactKeys(item, ["path", "reason", "relevantWhen"])) return undefined;
		if (!isNonEmptyString(item.path) || !isNonEmptyString(item.reason) || !isNonEmptyString(item.relevantWhen))
			return undefined;
		files.push({ path: item.path, reason: item.reason, relevantWhen: item.relevantWhen });
	}
	return files;
}

function parseUniqueStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!isNonEmptyString(item) || seen.has(item)) return undefined;
		seen.add(item);
		strings.push(item);
	}
	return strings;
}

function parseAutoreadReference(
	value: unknown,
): { rowId: string; path: string; servedHash: string; source: string; batchId: string } | undefined {
	if (!isRecord(value) || value.status !== "read") return undefined;
	if (
		!isNonEmptyString(value.rowId) ||
		!isNonEmptyString(value.path) ||
		!isNonEmptyString(value.cwd) ||
		!isNonEmptyString(value.source) ||
		!isNonEmptyString(value.batchId)
	)
		return undefined;
	if (!isRecord(value.readCache) || !isNonEmptyString(value.readCache.servedHash)) return undefined;
	return {
		rowId: value.rowId,
		path: value.path,
		servedHash: value.readCache.servedHash,
		source: value.source,
		batchId: value.batchId,
	};
}

function allCompleteExchanges(
	ids: readonly string[],
	calls: ReadonlyMap<string, { count: number; name: string; index: number }>,
	results: ReadonlyMap<string, { count: number; name: string; index: number }>,
): boolean {
	return ids.every((id) => {
		const call = calls.get(id);
		return call !== undefined && isCompleteExchange(id, call.name, calls, results);
	});
}

function isCompleteExchange(
	id: string,
	name: string,
	calls: ReadonlyMap<string, { count: number; name: string; index: number }>,
	results: ReadonlyMap<string, { count: number; name: string; index: number }>,
): boolean {
	const call = calls.get(id);
	const result = results.get(id);
	return (
		call?.count === 1 &&
		result?.count === 1 &&
		call.name === name &&
		result.name === name &&
		call.index < result.index
	);
}

function exchangePrecedes(
	id: string,
	anchorCallIndex: number,
	calls: ReadonlyMap<string, { index: number }>,
	results: ReadonlyMap<string, { index: number }>,
): boolean {
	const call = calls.get(id);
	const result = results.get(id);
	return call !== undefined && result !== undefined && call.index < result.index && result.index < anchorCallIndex;
}

function allAutoreads(ids: readonly string[], autoreads: ReadonlyMap<string, { count: number }>): boolean {
	return ids.every((id) => autoreads.get(id)?.count === 1);
}

function hasOverlap(left: readonly string[], right: readonly string[]): boolean {
	const rightSet = new Set(right);
	return left.some((item) => rightSet.has(item));
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
