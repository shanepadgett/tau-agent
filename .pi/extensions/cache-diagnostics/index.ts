import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_NOISE_FLOOR = 1_024;

interface ItemFingerprint {
	hash: string;
	bytes: number;
	type: string | null;
	role: string | null;
	name: string | null;
}

interface PayloadFingerprint {
	model: string | null;
	promptCacheKeyHash: string | null;
	instructionsHash: string | null;
	toolsHash: string | null;
	nonSequenceHash: string;
	sequenceField: "input" | "messages" | "none";
	items: ItemFingerprint[];
}

interface PendingRequest {
	id: string;
	previousExactPrefix: boolean;
	previousPromptTokens: number;
}

export default function cacheDiagnostics(pi: ExtensionAPI): void {
	const directory = join(getAgentDir(), "cache-diagnostics");
	const runtimeId = randomUUID();
	const pendingResults: PendingRequest[] = [];
	const pendingResponses: string[] = [];
	let logFile = "";
	let requestSequence = 0;
	let previousFingerprint: PayloadFingerprint | undefined;
	let previousPromptTokens = 0;
	let cacheActivitySeen = false;

	const appendRecord = async (record: object): Promise<void> => {
		if (!logFile) return;
		await appendFile(logFile, `${JSON.stringify(record)}\n`, "utf8");
	};

	pi.on("session_start", async (_event, ctx) => {
		await mkdir(directory, { recursive: true });
		const sessionId = ctx.sessionManager.getSessionId();
		logFile = join(directory, `${sessionId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);

		const cutoff = Date.now() - RETENTION_MS;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const path = join(directory, entry.name);
			if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
		}

		await appendRecord({
			kind: "runtime",
			version: 1,
			timestamp: new Date().toISOString(),
			runtimeId,
			sessionId,
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
		});
	});

	pi.on("before_provider_request", async (event) => {
		requestSequence += 1;
		const id = `${runtimeId}:${requestSequence}`;
		const fingerprint = fingerprintPayload(event.payload);
		let commonPrefixItems = 0;
		if (previousFingerprint) {
			const limit = Math.min(previousFingerprint.items.length, fingerprint.items.length);
			while (
				commonPrefixItems < limit &&
				previousFingerprint.items[commonPrefixItems]?.hash === fingerprint.items[commonPrefixItems]?.hash
			) {
				commonPrefixItems += 1;
			}
		}
		const stableEnvelope = previousFingerprint?.nonSequenceHash === fingerprint.nonSequenceHash;
		const previousExactPrefix =
			previousFingerprint !== undefined &&
			stableEnvelope &&
			previousFingerprint.sequenceField === fingerprint.sequenceField &&
			commonPrefixItems === previousFingerprint.items.length;
		const pending = { id, previousExactPrefix, previousPromptTokens } satisfies PendingRequest;
		pendingResults.push(pending);
		pendingResponses.push(id);

		await appendRecord({
			kind: "request",
			version: 1,
			timestamp: new Date().toISOString(),
			id,
			model: fingerprint.model,
			promptCacheKeyHash: fingerprint.promptCacheKeyHash,
			instructionsHash: fingerprint.instructionsHash,
			toolsHash: fingerprint.toolsHash,
			nonSequenceHash: fingerprint.nonSequenceHash,
			sequenceField: fingerprint.sequenceField,
			items: fingerprint.items,
			previousItems: previousFingerprint?.items.length ?? 0,
			commonPrefixItems,
			stableEnvelope,
			previousExactPrefix,
			previousPromptTokens,
		});
		previousFingerprint = fingerprint;
	});

	pi.on("after_provider_response", async (event) => {
		const id = pendingResponses.shift();
		if (!id) return;
		const selectedHeaders = Object.fromEntries(
			Object.entries(event.headers).filter(([name]) => {
				const normalized = name.toLowerCase();
				return normalized.includes("request-id") || normalized === "cf-ray";
			}),
		);
		await appendRecord({
			kind: "response",
			version: 1,
			timestamp: new Date().toISOString(),
			id,
			status: event.status,
			headers: selectedHeaders,
		});
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const pending = pendingResults.shift();
		if (!pending) return;
		const usage = event.message.usage;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const missedTokens = pending.previousExactPrefix
			? Math.max(0, Math.min(pending.previousPromptTokens, promptTokens) - usage.cacheRead)
			: 0;
		const cacheMiss = cacheActivitySeen && missedTokens > CACHE_NOISE_FLOOR;
		await appendRecord({
			kind: "result",
			version: 1,
			timestamp: new Date().toISOString(),
			id: pending.id,
			provider: event.message.provider,
			model: event.message.model,
			stopReason: event.message.stopReason,
			usage: {
				input: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				promptTokens,
			},
			previousExactPrefix: pending.previousExactPrefix,
			missedTokens,
			cacheMiss,
		});
		previousPromptTokens = promptTokens;
		cacheActivitySeen ||= usage.cacheRead + usage.cacheWrite > 0;
	});
}

function fingerprintPayload(payload: unknown): PayloadFingerprint {
	const record = isRecord(payload) ? payload : {};
	const sequenceField = Array.isArray(record.input) ? "input" : Array.isArray(record.messages) ? "messages" : "none";
	const sequence = sequenceField === "none" ? [] : (record[sequenceField] as unknown[]);
	const nonSequence = Object.fromEntries(Object.entries(record).filter(([key]) => key !== sequenceField));
	return {
		model: typeof record.model === "string" ? record.model : null,
		promptCacheKeyHash: valueHash(record.prompt_cache_key),
		instructionsHash: valueHash(record.instructions ?? record.system),
		toolsHash: valueHash(record.tools),
		nonSequenceHash: hashJson(nonSequence).hash,
		sequenceField,
		items: sequence.map((item) => {
			const fingerprint = hashJson(item);
			const itemRecord = isRecord(item) ? item : {};
			return {
				hash: fingerprint.hash,
				bytes: fingerprint.bytes,
				type: typeof itemRecord.type === "string" ? itemRecord.type : null,
				role: typeof itemRecord.role === "string" ? itemRecord.role : null,
				name: typeof itemRecord.name === "string" ? itemRecord.name : null,
			};
		}),
	};
}

function valueHash(value: unknown): string | null {
	return value === undefined ? null : hashJson(value).hash;
}

function hashJson(value: unknown): { hash: string; bytes: number } {
	const serialized = JSON.stringify(value) ?? "undefined";
	return {
		hash: createHash("sha256").update(serialized).digest("hex"),
		bytes: Buffer.byteLength(serialized, "utf8"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
