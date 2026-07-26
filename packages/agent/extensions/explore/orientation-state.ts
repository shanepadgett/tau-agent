import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { astLanguageForPath, type AstLanguage } from "./ast-languages.ts";

export type StructuralAttemptKind =
	| "directOutline"
	| "symbol"
	| "apiCandidate"
	| "structuralMatch"
	| "relationshipLocation"
	| "relationshipScope";
export type ReadGateDecision = StructuralAttemptKind | "fatalFallback" | "blocked";
export type ReadPermission = Exclude<ReadGateDecision, "blocked"> | "postPatchDiff" | "ungated";

export interface OrientationTelemetry {
	blockedReadAttempts: number;
	permittedReadAttempts: number;
	fallbackReadAttempts: number;
	permissionReadAttempts: Record<Exclude<ReadPermission, "ungated">, number>;
	workerInputBytes: number;
	completeRenderedBytes: number;
	modelVisibleAstBytes: number;
	sourceBytesDeflected: number;
	temporaryOutputBytes: number;
	directReadBytes: number;
	overflowReadBytes: number;
}

interface AttemptRecord {
	fingerprint: string;
	kind: StructuralAttemptKind;
}

interface FatalFallbackRecord {
	fingerprint: string;
	includePrivate: boolean;
	names: readonly string[];
	diagnostic: {
		code: "outline_failed" | "outlineFailed" | "response_too_large" | "resultFrameTooLarge";
		message: string;
	};
}

interface FileState {
	attempt: AttemptRecord | undefined;
	fallback: FatalFallbackRecord | undefined;
	patchFingerprint: string | undefined;
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
			kind: "structuralAttempt";
			sourceBytesDeflected: number;
	  }
	| {
			toolCallId: string;
			kind: "blockedRead";
	  }
	| {
			toolCallId: string;
			kind: "read";
			permission: ReadPermission;
			returnedBytes: number;
			overflow: boolean;
	  };

export interface OrientationState {
	supports(path: string): Promise<boolean>;
	check(path: string, fingerprint: string): ReadGateDecision;
	checkPatch(path: string, fingerprint: string): boolean;
	recordAttempts(
		records: readonly {
			path: string;
			fingerprint: string;
			kind: StructuralAttemptKind;
			toolCallId: string;
			sourceBytesDeflected: number;
		}[],
	): void;
	recordFatal(input: {
		path: string;
		fingerprint: string;
		includePrivate: boolean;
		names: readonly string[];
		code: "outline_failed" | "outlineFailed" | "response_too_large" | "resultFrameTooLarge";
		message: string;
	}): void;
	recordPatched(records: readonly { path: string; resultingFingerprint: string | null }[]): void;
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
	recordRead(toolCallId: string, path: string, permission: ReadPermission, returnedBytes: number): void;
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
		const state: FileState = { attempt: undefined, fallback: undefined, patchFingerprint: undefined };
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
			if (state.attempt && state.attempt.fingerprint !== fingerprint) state.attempt = undefined;
			if (state.fallback && state.fallback.fingerprint !== fingerprint) state.fallback = undefined;
			if (state.attempt?.fingerprint === fingerprint) return state.attempt.kind;
			return state.fallback?.fingerprint === fingerprint ? "fatalFallback" : "blocked";
		},
		checkPatch(path, fingerprint) {
			const state = files.get(canonicalPathForState(path));
			if (!state?.patchFingerprint) return false;
			if (state.patchFingerprint === fingerprint) return true;
			state.patchFingerprint = undefined;
			return false;
		},
		recordAttempts(records) {
			for (const record of records) {
				const state = stateFor(record.path);
				state.attempt = { fingerprint: record.fingerprint, kind: record.kind };
				state.fallback = undefined;
				events.push({
					toolCallId: record.toolCallId,
					kind: "structuralAttempt",
					sourceBytesDeflected: record.sourceBytesDeflected,
				});
			}
		},
		recordFatal(input) {
			const state = stateFor(input.path);
			state.fallback = {
				fingerprint: input.fingerprint,
				includePrivate: input.includePrivate,
				names: [...input.names],
				diagnostic: { code: input.code, message: input.message },
			};
		},
		recordPatched(records) {
			for (const record of records) {
				if (record.resultingFingerprint === null) continue;
				stateFor(record.path).patchFingerprint = record.resultingFingerprint;
			}
		},
		recordOutlineTelemetry(toolCallId, metrics) {
			events.push({ toolCallId, kind: "outline", ...metrics });
		},
		recordBlockedRead(toolCallId, path) {
			stateFor(path);
			events.push({ toolCallId, kind: "blockedRead" });
		},
		recordRead(toolCallId, path, permission, returnedBytes) {
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
			const permissionReadAttempts: OrientationTelemetry["permissionReadAttempts"] = {
				directOutline: 0,
				symbol: 0,
				apiCandidate: 0,
				structuralMatch: 0,
				relationshipLocation: 0,
				relationshipScope: 0,
				fatalFallback: 0,
				postPatchDiff: 0,
			};
			const result: OrientationTelemetry = {
				blockedReadAttempts: 0,
				permittedReadAttempts: 0,
				fallbackReadAttempts: 0,
				permissionReadAttempts,
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
				} else if (event.kind === "structuralAttempt") {
					result.sourceBytesDeflected += event.sourceBytesDeflected;
				} else if (event.kind === "blockedRead") {
					result.blockedReadAttempts += 1;
				} else {
					result.directReadBytes += event.returnedBytes;
					if (event.overflow) result.overflowReadBytes += event.returnedBytes;
					if (event.permission !== "ungated") {
						result.permittedReadAttempts += 1;
						result.permissionReadAttempts[event.permission] += 1;
					}
					if (event.permission === "fatalFallback") result.fallbackReadAttempts += 1;
				}
			}
			return result;
		},
		invalidate(paths) {
			for (const path of paths) {
				const state = files.get(canonicalPathForState(path));
				if (!state) continue;
				state.attempt = undefined;
				state.fallback = undefined;
				state.patchFingerprint = undefined;
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
