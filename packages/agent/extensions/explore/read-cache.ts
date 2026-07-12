import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ReadCacheMode = "baseline" | "recovery" | "unchanged" | "diff";

export interface ReadCacheMetaV1 {
	v: 1;
	pathKey: string;
	scopeKey: string;
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
	sequence: number;
}

interface ReplayState {
	trust: Map<string, Map<string, ScopeTrust>>;
	unlockedPaths: Set<string>;
	sequence: number;
}

interface OverlayState {
	trust: Map<string, Map<string, ScopeTrust>>;
	sequence: number;
}

export interface ReadCacheDecision {
	baseHash?: string;
	recovery: boolean;
}

export interface ReadCacheStore {
	decision(ctx: ExtensionContext, pathKey: string, scopeKey: string): ReadCacheDecision;
	record(ctx: ExtensionContext, meta: ReadCacheMetaV1): void;
	clear(): void;
}

export function createReadCacheStore(): ReadCacheStore {
	const overlays = new Map<string, OverlayState>();

	return {
		decision(ctx, pathKey, scopeKey) {
			const state = replay(ctx);
			const overlay = overlays.get(overlayKey(ctx));
			if (overlay) mergeTrust(state, overlay.trust);
			return {
				baseHash: state.trust.get(pathKey)?.get(scopeKey)?.hash,
				recovery: state.unlockedPaths.has(pathKey),
			};
		},
		record(ctx, meta) {
			const key = overlayKey(ctx);
			let overlay = overlays.get(key);
			if (!overlay) {
				overlay = { trust: new Map(), sequence: 1_000_000_000 };
				overlays.set(key, overlay);
			}
			overlay.sequence += 1;
			setTrust(overlay.trust, meta.pathKey, meta.scopeKey, meta.servedHash, overlay.sequence);
			while (overlays.size > 32) {
				const oldest = overlays.keys().next().value as string | undefined;
				if (oldest === undefined) break;
				overlays.delete(oldest);
			}
		},
		clear() {
			overlays.clear();
		},
	};
}

function parseReadCacheMeta(value: unknown): ReadCacheMetaV1 | undefined {
	if (!isRecord(value) || value.v !== 1) return undefined;
	if (typeof value.pathKey !== "string" || typeof value.scopeKey !== "string") return undefined;
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
	const state: ReplayState = { trust: new Map(), unlockedPaths: new Set(), sequence: 0 };
	const manager = ctx.sessionManager;
	if (!manager) return state;
	const branch = manager.getBranch();
	let start = 0;
	for (let index = 0; index < branch.length; index += 1) {
		const entry = branch[index];
		if (isRecord(entry) && entry.type === "compaction") start = index + 1;
	}

	for (const entry of branch.slice(start)) {
		if (!isRecord(entry) || entry.type !== "message" || !("message" in entry)) continue;
		const message = entry.message;
		const meta = readMetaFromMessage(message);
		if (meta) {
			state.sequence += 1;
			applyReadMeta(state, meta);
			continue;
		}
		for (const path of failedPatchPaths(message, ctx.cwd)) state.unlockedPaths.add(path);
	}
	return state;
}

function applyReadMeta(state: ReplayState, meta: ReadCacheMetaV1): void {
	const existing = state.trust.get(meta.pathKey)?.get(meta.scopeKey);
	if (meta.mode === "baseline" || meta.mode === "recovery") {
		setTrust(state.trust, meta.pathKey, meta.scopeKey, meta.servedHash, state.sequence);
		state.unlockedPaths.delete(meta.pathKey);
		return;
	}
	if (!meta.baseHash || existing?.hash !== meta.baseHash) return;
	if (meta.mode === "unchanged" && meta.servedHash !== meta.baseHash) return;
	setTrust(state.trust, meta.pathKey, meta.scopeKey, meta.servedHash, state.sequence);
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
	hash: string,
	sequence: number,
): void {
	let scopes = trust.get(pathKey);
	if (!scopes) {
		scopes = new Map();
		trust.set(pathKey, scopes);
	}
	scopes.set(scopeKey, { hash, sequence });
}

function mergeTrust(state: ReplayState, overlay: Map<string, Map<string, ScopeTrust>>): void {
	for (const [pathKey, scopes] of overlay) {
		for (const [scopeKey, candidate] of scopes) {
			const current = state.trust.get(pathKey)?.get(scopeKey);
			if (!current || candidate.sequence > current.sequence) {
				setTrust(state.trust, pathKey, scopeKey, candidate.hash, candidate.sequence);
			}
		}
	}
}

function overlayKey(ctx: ExtensionContext): string {
	const manager = ctx.sessionManager;
	if (!manager) return `test:${ctx.cwd}`;
	return `${manager.getSessionId()}:${manager.getLeafId() ?? "root"}`;
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
