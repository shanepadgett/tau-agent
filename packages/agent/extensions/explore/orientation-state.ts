import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { astLanguageForPath, type AstLanguage } from "./ast-languages.ts";
import type { SymbolView } from "./ast-worker.ts";

export interface OrientationTelemetry {
	blockedReadAttempts: number;
	permittedReadAttempts: number;
	fallbackReadAttempts: number;
	workerInputBytes: number;
	completeRenderedBytes: number;
	modelVisibleAstBytes: number;
	sourceBytesDeflected: number;
	temporaryOutputBytes: number;
	directReadBytes: number;
	overflowReadBytes: number;
}

export type ReadGateDecision = "oriented" | "fallback" | "blocked";

interface OrientationRecord {
	fingerprint: string;
	completeFileBlockVisible: true;
	includePrivate: boolean;
	names: readonly string[];
	diagnostics: { errorNodes: number; missingNodes: number };
	workerProducedUsableResult: true;
}

interface FatalFallbackRecord {
	fingerprint: string;
	includePrivate: boolean;
	names: readonly string[];
	diagnostic: {
		code: "outline_failed" | "outlineFailed" | "response_too_large" | "resultFrameTooLarge";
		message: string;
	};
	workerProducedUsableResult: false;
}

interface FileState {
	orientation: OrientationRecord | undefined;
	fallback: FatalFallbackRecord | undefined;
	retrievedLocatorIds: Set<number>;
	symbolViews: Set<SymbolView>;
	blockedReadAttempts: number;
	permittedReadAttempts: number;
	sourceBytesDeflected: number;
}

type TelemetryEvent =
	| {
			toolCallId: string;
			kind: "outline";
			workerInputBytes: number;
			completeRenderedBytes: number;
			modelVisibleAstBytes: number;
			temporaryOutputBytes: number;
	  }
	| {
			toolCallId: string;
			kind: "visibleOutline";
			sourceBytesDeflected: number;
	  }
	| {
			toolCallId: string;
			kind: "blockedRead";
	  }
	| {
			toolCallId: string;
			kind: "read";
			permission: "oriented" | "fallback" | "ungated";
			returnedBytes: number;
			overflow: boolean;
	  };

export interface OrientationState {
	supports(path: string): Promise<boolean>;
	check(path: string, fingerprint: string): ReadGateDecision;
	recordVisible(input: {
		path: string;
		toolCallId: string;
		fingerprint: string;
		includePrivate: boolean;
		names: readonly string[];
		diagnostics: { errorNodes: number; missingNodes: number };
		locatorIds: readonly number[];
		sourceBytesDeflected: number;
	}): void;
	recordFatal(input: {
		path: string;
		fingerprint: string;
		includePrivate: boolean;
		names: readonly string[];
		code: "outline_failed" | "outlineFailed" | "response_too_large" | "resultFrameTooLarge";
		message: string;
	}): void;
	recordSymbols(records: readonly { path: string; locatorId: number; view: SymbolView }[]): void;
	recordOutlineTelemetry(
		toolCallId: string,
		metrics: {
			workerInputBytes: number;
			completeRenderedBytes: number;
			modelVisibleAstBytes: number;
			temporaryOutputBytes: number;
		},
	): void;
	recordBlockedRead(toolCallId: string, path: string): void;
	recordRead(
		toolCallId: string,
		path: string,
		permission: "oriented" | "fallback" | "ungated",
		returnedBytes: number,
	): void;
	recordTemporaryOutput(path: string): void;
	telemetry(includedToolCallIds: ReadonlySet<string> | undefined): OrientationTelemetry;
	invalidate(paths: readonly string[]): void;
	clear(): void;
	resetGate(): void;
}

export function sourceFingerprint(source: Uint8Array): string {
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function createOrientationState(workerLanguages: () => Promise<readonly AstLanguage[]>): OrientationState {
	const files = new Map<string, FileState>();
	const temporaryOutputs = new Set<string>();
	const events: TelemetryEvent[] = [];

	function stateFor(path: string): FileState {
		const canonicalPath = canonicalPathForState(path);
		const existing = files.get(canonicalPath);
		if (existing) return existing;
		const state: FileState = {
			orientation: undefined,
			fallback: undefined,
			retrievedLocatorIds: new Set(),
			symbolViews: new Set(),
			blockedReadAttempts: 0,
			permittedReadAttempts: 0,
			sourceBytesDeflected: 0,
		};
		files.set(canonicalPath, state);
		return state;
	}

	return {
		async supports(path) {
			const language = astLanguageForPath(canonicalPathForState(path));
			if (!language) return false;
			try {
				return (await workerLanguages()).includes(language);
			} catch {
				return false;
			}
		},
		check(path, fingerprint) {
			const state = files.get(canonicalPathForState(path));
			if (!state) return "blocked";
			if (state.orientation && state.orientation.fingerprint !== fingerprint) {
				state.orientation = undefined;
				state.retrievedLocatorIds.clear();
				state.symbolViews.clear();
			}
			if (state.fallback && state.fallback.fingerprint !== fingerprint) state.fallback = undefined;
			if (state.orientation?.fingerprint === fingerprint) return "oriented";
			return state.fallback?.fingerprint === fingerprint ? "fallback" : "blocked";
		},
		recordVisible(input) {
			const state = stateFor(input.path);
			state.orientation = {
				fingerprint: input.fingerprint,
				completeFileBlockVisible: true,
				includePrivate: input.includePrivate,
				names: [...input.names],
				diagnostics: { ...input.diagnostics },
				workerProducedUsableResult: true,
			};
			state.fallback = undefined;
			state.retrievedLocatorIds = new Set(input.locatorIds);
			state.symbolViews.clear();
			state.sourceBytesDeflected += input.sourceBytesDeflected;
			events.push({
				toolCallId: input.toolCallId,
				kind: "visibleOutline",
				sourceBytesDeflected: input.sourceBytesDeflected,
			});
		},
		recordFatal(input) {
			const state = stateFor(input.path);
			state.fallback = {
				fingerprint: input.fingerprint,
				includePrivate: input.includePrivate,
				names: [...input.names],
				diagnostic: { code: input.code, message: input.message },
				workerProducedUsableResult: false,
			};
		},
		recordSymbols(records) {
			for (const record of records) {
				const state = stateFor(record.path);
				state.retrievedLocatorIds.add(record.locatorId);
				state.symbolViews.add(record.view);
			}
		},
		recordOutlineTelemetry(toolCallId, metrics) {
			events.push({ toolCallId, kind: "outline", ...metrics });
		},
		recordBlockedRead(toolCallId, path) {
			stateFor(path).blockedReadAttempts += 1;
			events.push({ toolCallId, kind: "blockedRead" });
		},
		recordRead(toolCallId, path, permission, returnedBytes) {
			if (permission !== "ungated") stateFor(path).permittedReadAttempts += 1;
			events.push({
				toolCallId,
				kind: "read",
				permission,
				returnedBytes,
				overflow: temporaryOutputs.has(canonicalPathForState(path)),
			});
		},
		recordTemporaryOutput(path) {
			temporaryOutputs.add(canonicalPathForState(path));
		},
		telemetry(includedToolCallIds) {
			const result: OrientationTelemetry = {
				blockedReadAttempts: 0,
				permittedReadAttempts: 0,
				fallbackReadAttempts: 0,
				workerInputBytes: 0,
				completeRenderedBytes: 0,
				modelVisibleAstBytes: 0,
				sourceBytesDeflected: 0,
				temporaryOutputBytes: 0,
				directReadBytes: 0,
				overflowReadBytes: 0,
			};
			for (const event of events) {
				if (includedToolCallIds && !includedToolCallIds.has(event.toolCallId)) continue;
				if (event.kind === "outline") {
					result.workerInputBytes += event.workerInputBytes;
					result.completeRenderedBytes += event.completeRenderedBytes;
					result.modelVisibleAstBytes += event.modelVisibleAstBytes;
					result.temporaryOutputBytes += event.temporaryOutputBytes;
				} else if (event.kind === "visibleOutline") {
					result.sourceBytesDeflected += event.sourceBytesDeflected;
				} else if (event.kind === "blockedRead") {
					result.blockedReadAttempts += 1;
				} else {
					result.directReadBytes += event.returnedBytes;
					if (event.overflow) result.overflowReadBytes += event.returnedBytes;
					if (event.permission !== "ungated") result.permittedReadAttempts += 1;
					if (event.permission === "fallback") result.fallbackReadAttempts += 1;
				}
			}
			return result;
		},
		invalidate(paths) {
			for (const path of paths) {
				const state = files.get(canonicalPathForState(path));
				if (!state) continue;
				state.orientation = undefined;
				state.fallback = undefined;
				state.retrievedLocatorIds.clear();
				state.symbolViews.clear();
			}
		},
		clear() {
			files.clear();
			temporaryOutputs.clear();
			events.length = 0;
		},
		resetGate() {
			files.clear();
		},
	};
}

function canonicalPathForState(path: string): string {
	const absolutePath = resolve(path);
	try {
		return realpathSync(absolutePath);
	} catch {
		return absolutePath;
	}
}
