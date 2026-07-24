import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { replayContextPruningState } from "../../shared/context-pruning-state.ts";
import { applyCompleteFileDiff, COMPLETE_FILE_SCOPE, decodeCompleteFileSource } from "./full-file-knowledge.ts";

export type ReadCacheMode = "baseline" | "recovery" | "unchanged" | "diff";
export type ReadCachePresentation = "plain" | "line-numbered";

export interface ReadCacheMetaV1 {
	v: 1;
	pathKey: string;
	scopeKey: string;
	presentation: ReadCachePresentation;
	servedHash: string;
	baseHash?: string;
	mode: ReadCacheMode;
	baselineTokens: number;
	returnedTokens: number;
	totalLines: number;
	summary: string;
}

export interface ReadCacheScopeTrust {
	hash: string;
	text?: string;
	rowIds: readonly string[];
}

export interface AcceptedReadCacheRow {
	rowId: string;
	pathKey: string;
	scopeKey: string;
	meta: ReadCacheMetaV1;
	dependencyRowIds: readonly string[];
}

export interface CompleteFileDependencyChain {
	pathKey: string;
	servedHash: string;
	rowIds: readonly string[];
	sourceText: string;
}

export interface ReadCacheReplayResult {
	scopeTrust: ReadonlyMap<string, ReadonlyMap<string, ReadCacheScopeTrust>>;
	acceptedRows: readonly AcceptedReadCacheRow[];
	completeFileChains: ReadonlyMap<string, CompleteFileDependencyChain>;
	failedPatchRecoveryPaths: ReadonlySet<string>;
}

export interface ReadCacheDecision {
	baseHash?: string;
	baselineText?: string;
	recovery: boolean;
}

export interface ReadCacheStore {
	decision(ctx: ExtensionContext, pathKey: string, scopeKey: string): ReadCacheDecision;
}

export function createReadCacheStore(): ReadCacheStore {
	return {
		decision(ctx, pathKey, scopeKey) {
			const manager = ctx.sessionManager;
			if (!manager) {
				return { baseHash: undefined, baselineText: undefined, recovery: false };
			}
			const pruning = replayContextPruningState(manager.getBranch());
			const ignoredRowIds = new Set([...pruning.prunedToolCallIds, ...pruning.prunedAutoreadRowIds]);
			for (const id of pruning.retainedToolCallIds) ignoredRowIds.delete(id);
			const state = replayReadCache(manager.buildContextEntries(), ctx.cwd, ignoredRowIds);
			const trust = state.scopeTrust.get(pathKey)?.get(scopeKey);
			return {
				baseHash: trust?.hash,
				baselineText: trust?.text,
				recovery: state.failedPatchRecoveryPaths.has(pathKey),
			};
		},
	};
}

function parseReadCacheMeta(value: unknown): ReadCacheMetaV1 | undefined {
	if (!isRecord(value) || value.v !== 1) return undefined;
	if (typeof value.pathKey !== "string" || typeof value.scopeKey !== "string") return undefined;
	if (value.presentation !== "plain" && value.presentation !== "line-numbered") return undefined;
	if (typeof value.servedHash !== "string" || value.servedHash.length === 0) return undefined;
	if (!isReadCacheMode(value.mode)) return undefined;
	if (!isNonNegativeFinite(value.baselineTokens) || !isNonNegativeFinite(value.returnedTokens)) return undefined;
	if (!isNonNegativeFinite(value.totalLines) || typeof value.summary !== "string") return undefined;
	if (value.baseHash !== undefined && typeof value.baseHash !== "string") return undefined;
	if ((value.mode === "unchanged" || value.mode === "diff") && !value.baseHash) return undefined;
	return {
		v: 1,
		pathKey: value.pathKey,
		scopeKey: value.scopeKey,
		presentation: value.presentation,
		servedHash: value.servedHash,
		baseHash: value.baseHash,
		mode: value.mode,
		baselineTokens: value.baselineTokens,
		returnedTokens: value.returnedTokens,
		totalLines: value.totalLines,
		summary: value.summary,
	};
}

export function readMetaFromMessage(message: unknown): ReadCacheMetaV1 | undefined {
	if (!isRecord(message)) return undefined;
	const isReadResult = message.role === "toolResult" && message.toolName === "read";
	const isAutoread = message.customType === "tau.autoread";
	if (!isReadResult && !isAutoread) return undefined;
	if (!isRecord(message.details)) return undefined;
	if (isAutoread && message.details.status !== "read") return undefined;
	return parseReadCacheMeta(message.details.readCache);
}

export function replayReadCache(
	entries: readonly unknown[],
	cwd: string,
	ignoredRowIds: ReadonlySet<string> = new Set(),
): ReadCacheReplayResult {
	const trust = new Map<string, Map<string, ReadCacheScopeTrust>>();
	const acceptedRows: AcceptedReadCacheRow[] = [];
	const failedPatchRecoveryPaths = new Set<string>();
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		let message: unknown;
		if (entry.type === "message" && "message" in entry) message = entry.message;
		else if (entry.type === "custom_message") message = entry;
		else continue;
		const parsedMeta = readMetaFromMessage(message);
		if (parsedMeta) {
			const rowId = readRowId(message);
			if (!rowId || ignoredRowIds.has(rowId)) continue;
			const pathKey = resolve(cwd, parsedMeta.pathKey);
			const meta = pathKey === parsedMeta.pathKey ? parsedMeta : { ...parsedMeta, pathKey };
			if (applyReadMeta(trust, failedPatchRecoveryPaths, message, meta, rowId)) {
				const acceptedTrust = trust.get(meta.pathKey)?.get(meta.scopeKey);
				if (acceptedTrust)
					acceptedRows.push({
						rowId,
						pathKey: meta.pathKey,
						scopeKey: meta.scopeKey,
						meta,
						dependencyRowIds: [...acceptedTrust.rowIds],
					});
			}
			continue;
		}
		for (const path of failedPatchPaths(message, cwd)) failedPatchRecoveryPaths.add(path);
	}
	const completeFileChains = new Map<string, CompleteFileDependencyChain>();
	for (const [pathKey, scopes] of trust) {
		const complete = scopes.get(COMPLETE_FILE_SCOPE);
		if (!complete || complete.text === undefined) continue;
		completeFileChains.set(pathKey, {
			pathKey,
			servedHash: complete.hash,
			rowIds: [...complete.rowIds],
			sourceText: complete.text,
		});
	}
	return { scopeTrust: trust, acceptedRows, completeFileChains, failedPatchRecoveryPaths };
}

function applyReadMeta(
	trust: Map<string, Map<string, ReadCacheScopeTrust>>,
	failedPatchRecoveryPaths: Set<string>,
	message: unknown,
	meta: ReadCacheMetaV1,
	rowId: string,
): boolean {
	const existing = trust.get(meta.pathKey)?.get(meta.scopeKey);
	if (meta.mode === "baseline" || meta.mode === "recovery") {
		let text: string | undefined;
		if (meta.scopeKey === COMPLETE_FILE_SCOPE) {
			if (!isRecord(message)) return false;
			let pathHeader: string | undefined;
			if (message.customType === "tau.autoread") {
				if (!isRecord(message.details)) return false;
				if (typeof message.details.path !== "string" || typeof message.details.cwd !== "string") return false;
				if (resolve(message.details.cwd, message.details.path) !== meta.pathKey) return false;
				pathHeader = message.details.path;
			}
			const decoded = decodeCompleteFileSource({
				content: message.content,
				autoread: message.customType === "tau.autoread",
				...(pathHeader === undefined ? {} : { pathHeader }),
				presentation: meta.presentation,
				servedHash: meta.servedHash,
			});
			if (!decoded.valid || decoded.text === undefined) return false;
			text = decoded.text;
		}
		setTrust(trust, meta.pathKey, meta.scopeKey, { hash: meta.servedHash, text, rowIds: [rowId] });
		failedPatchRecoveryPaths.delete(meta.pathKey);
		return true;
	}
	if (!meta.baseHash || existing?.hash !== meta.baseHash) return false;
	if (meta.mode === "unchanged" && meta.servedHash !== meta.baseHash) return false;
	let text = meta.mode === "unchanged" ? existing.text : undefined;
	if (meta.scopeKey === COMPLETE_FILE_SCOPE && meta.mode === "diff") {
		if (existing.text === undefined) return false;
		const decoded = applyCompleteFileDiff({
			content: isRecord(message) ? message.content : undefined,
			baseText: existing.text,
			baseHash: meta.baseHash,
			servedHash: meta.servedHash,
		});
		if (!decoded.valid || decoded.text === undefined) return false;
		text = decoded.text;
	}
	setTrust(trust, meta.pathKey, meta.scopeKey, {
		hash: meta.servedHash,
		text,
		rowIds: [...existing.rowIds, rowId],
	});
	return true;
}

function readRowId(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	if (message.role === "toolResult" && message.toolName === "read") {
		return typeof message.toolCallId === "string" && message.toolCallId.length > 0 ? message.toolCallId : undefined;
	}
	if (message.customType !== "tau.autoread" || !isRecord(message.details)) return undefined;
	return typeof message.details.rowId === "string" && message.details.rowId.length > 0
		? message.details.rowId
		: undefined;
}

function failedPatchPaths(message: unknown, cwd: string): string[] {
	if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "patch") return [];
	if (
		!isRecord(message.details) ||
		message.details.status === "completed" ||
		!Array.isArray(message.details.failures)
	) {
		return [];
	}
	const paths: string[] = [];
	for (const failure of message.details.failures) {
		if (!isRecord(failure) || typeof failure.path !== "string" || failure.path.trim().length === 0) continue;
		paths.push(resolve(cwd, failure.path));
	}
	return paths;
}

function setTrust(
	trust: Map<string, Map<string, ReadCacheScopeTrust>>,
	pathKey: string,
	scopeKey: string,
	value: ReadCacheScopeTrust,
): void {
	let scopes = trust.get(pathKey);
	if (!scopes) {
		scopes = new Map();
		trust.set(pathKey, scopes);
	}
	scopes.set(scopeKey, value);
}

function isReadCacheMode(value: unknown): value is ReadCacheMode {
	return value === "baseline" || value === "recovery" || value === "unchanged" || value === "diff";
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
