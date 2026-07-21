import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { COMPLETE_FILE_SCOPE, decodeCompleteFileSource } from "./full-file-knowledge.ts";

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

interface ScopeTrust {
	hash: string;
	text?: string;
}

interface ReplayState {
	trust: Map<string, Map<string, ScopeTrust>>;
	unlockedPaths: Set<string>;
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
			const state = replay(ctx);
			const trust = state.trust.get(pathKey)?.get(scopeKey);
			return {
				baseHash: trust?.hash,
				baselineText: trust?.text,
				recovery: state.unlockedPaths.has(pathKey),
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

function replay(ctx: ExtensionContext): ReplayState {
	const state: ReplayState = { trust: new Map(), unlockedPaths: new Set() };
	const manager = ctx.sessionManager;
	if (!manager) return state;
	const branch = manager.getBranch();
	let start = 0;
	for (let index = 0; index < branch.length; index += 1) {
		const entry = branch[index];
		if (isRecord(entry) && entry.type === "compaction") start = index + 1;
	}

	for (const entry of branch.slice(start)) {
		if (!isRecord(entry)) continue;
		let message: unknown;
		if (entry.type === "message" && "message" in entry) message = entry.message;
		else if (entry.type === "custom_message") message = entry;
		else continue;
		const meta = readMetaFromMessage(message);
		if (meta) {
			applyReadMeta(state, message, meta);
			continue;
		}
		for (const path of failedPatchPaths(message, ctx.cwd)) state.unlockedPaths.add(path);
	}
	return state;
}

function applyReadMeta(state: ReplayState, message: unknown, meta: ReadCacheMetaV1): void {
	const existing = state.trust.get(meta.pathKey)?.get(meta.scopeKey);
	if (meta.mode === "baseline" || meta.mode === "recovery") {
		let text: string | undefined;
		if (meta.scopeKey === COMPLETE_FILE_SCOPE) {
			if (!isRecord(message)) return;
			let pathHeader: string | undefined;
			if (message.customType === "tau.autoread") {
				if (!isRecord(message.details)) return;
				if (typeof message.details.path !== "string" || typeof message.details.cwd !== "string") return;
				if (resolve(message.details.cwd, message.details.path) !== meta.pathKey) return;
				pathHeader = message.details.path;
			}
			const decoded = decodeCompleteFileSource({
				content: message.content,
				autoread: message.customType === "tau.autoread",
				...(pathHeader === undefined ? {} : { pathHeader }),
				presentation: meta.presentation,
				servedHash: meta.servedHash,
			});
			if (!decoded.valid || decoded.text === undefined) return;
			text = decoded.text;
		}
		setTrust(state.trust, meta.pathKey, meta.scopeKey, { hash: meta.servedHash, text });
		state.unlockedPaths.delete(meta.pathKey);
		return;
	}
	if (!meta.baseHash || existing?.hash !== meta.baseHash) return;
	if (meta.mode === "unchanged" && meta.servedHash !== meta.baseHash) return;
	setTrust(state.trust, meta.pathKey, meta.scopeKey, {
		hash: meta.servedHash,
		text: meta.mode === "unchanged" ? existing.text : undefined,
	});
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
	trust: Map<string, Map<string, ScopeTrust>>,
	pathKey: string,
	scopeKey: string,
	value: ScopeTrust,
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
