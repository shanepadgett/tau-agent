import { createHash, randomUUID } from "node:crypto";
import { appendFile, type FileHandle, mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type BuildSystemPromptOptions, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_NOISE_FLOOR = 1_024;
const MAX_MEMORY_RECORDS = 500;
const MAX_REPORT_INCIDENTS = 20;
const RECENT_REPORT_REQUESTS = 30;
const MAX_LOG_TAIL_BYTES = 10 * 1_024 * 1_024;

interface HashFingerprint {
	hash: string;
	bytes: number;
}

interface ItemFingerprint extends HashFingerprint {
	type: string | null;
	role: string | null;
	name: string | null;
}

interface ToolFingerprint extends HashFingerprint {
	name: string | null;
}

interface FieldFingerprint extends HashFingerprint {
	name: string;
}

interface PromptState {
	hash: string;
	systemPromptHash: string;
	selectedTools: string[];
	toolSnippetsHash: string | null;
	promptGuidelinesHash: string | null;
	appendSystemPromptHash: string | null;
	customPromptHash: string | null;
	contextFiles: Array<{ path: string; hash: string }>;
	skills: Array<{ name: string | null; path: string | null }>;
}

interface PayloadFingerprint {
	model: string | null;
	promptCacheKeyHash: string | null;
	instructionsHash: string | null;
	toolsHash: string | null;
	nonSequenceHash: string;
	sequenceField: "input" | "messages" | "none";
	fields: FieldFingerprint[];
	tools: ToolFingerprint[];
	items: ItemFingerprint[];
}

interface RequestRecord {
	kind: "request";
	version: 2;
	timestamp: string;
	id: string;
	turnIndex: number | null;
	previousRequestId: string | null;
	model: string | null;
	promptCacheKeyHash: string | null;
	instructionsHash: string | null;
	toolsHash: string | null;
	nonSequenceHash: string;
	sequenceField: "input" | "messages" | "none";
	fields: FieldFingerprint[];
	tools: ToolFingerprint[];
	items: ItemFingerprint[];
	previousItems: number;
	commonPrefixItems: number;
	stableEnvelope: boolean;
	previousExactPrefix: boolean;
	previousPromptTokens: number;
	changes: {
		envelopeFields: string[];
		toolsAdded: string[];
		toolsRemoved: string[];
		toolsChanged: string[];
		firstChangedItem: number | null;
		promptStateChanged: boolean;
	};
	promptState: PromptState | null;
}

interface ResponseRecord {
	kind: "response";
	version: 2;
	timestamp: string;
	id: string;
	status: number;
	headers: Record<string, string>;
}

interface ResultRecord {
	kind: "result";
	version: 2;
	timestamp: string;
	id: string;
	provider: string;
	model: string;
	stopReason: string;
	usage: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		promptTokens: number;
	};
	previousExactPrefix: boolean;
	missedTokens: number;
	cacheMiss: boolean;
	baselinePromoted: boolean;
}

interface MarkerRecord {
	kind: "marker";
	version: 2;
	timestamp: string;
	name: string;
	details: Record<string, string | number | boolean | null>;
}

interface Attempt {
	id: string;
	fingerprint: PayloadFingerprint;
	request: RequestRecord;
	responseStatus: number | undefined;
}

export default function cacheDiagnosticsExtension(pi: ExtensionAPI): void {
	const directory = join(getAgentDir(), "cache-diagnostics");
	const reportsDirectory = join(directory, "reports");
	const runtimeId = randomUUID();
	let logFile = "";
	let cwd = "";
	let sessionId = "";
	let sessionFile: string | null = null;
	let requestSequence = 0;
	let turnIndex: number | null = null;
	let latestPromptState: PromptState | null = null;
	let previousPromptState: PromptState | null = null;
	let previousFingerprint: PayloadFingerprint | undefined;
	let previousRequestId: string | null = null;
	let previousPromptTokens = 0;
	let cacheActivitySeen = false;
	let awaitingResponses: Attempt[] = [];
	let turnAttempts: Attempt[] = [];
	let requests: RequestRecord[] = [];
	let responses: ResponseRecord[] = [];
	let results: ResultRecord[] = [];
	let markers: MarkerRecord[] = [];

	const appendRecord = async (record: object): Promise<void> => {
		const path = logFile;
		if (!path) return;
		await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
	};
	const addMarker = async (
		name: string,
		details: Record<string, string | number | boolean | null> = {},
	): Promise<void> => {
		const marker: MarkerRecord = {
			kind: "marker",
			version: 2,
			timestamp: new Date().toISOString(),
			name,
			details,
		};
		markers = keepRecent([...markers, marker]);
		await appendRecord(marker);
	};
	const resetComparison = () => {
		previousFingerprint = undefined;
		previousRequestId = null;
		previousPromptState = null;
		previousPromptTokens = 0;
		cacheActivitySeen = false;
	};

	pi.registerCommand("cache-debug", {
		description: "Write a bounded prompt-cache diagnostic report for this session",
		async handler(_args, ctx) {
			await mkdir(reportsDirectory, { recursive: true });
			const incidentResults = results.filter((result) => result.cacheMiss).slice(-MAX_REPORT_INCIDENTS);
			const selectedIds = new Set<string>();
			for (const result of incidentResults) {
				selectedIds.add(result.id);
				const request = requests.find((candidate) => candidate.id === result.id);
				if (request?.previousRequestId) selectedIds.add(request.previousRequestId);
			}
			for (const request of requests.slice(-RECENT_REPORT_REQUESTS)) selectedIds.add(request.id);
			const selectedRequests = requests.filter((request) => selectedIds.has(request.id));
			const selectedResponses = responses.filter((response) => selectedIds.has(response.id));
			const selectedResults = results.filter((result) => selectedIds.has(result.id));
			const createdAt = new Date().toISOString();
			const safeSessionId = (sessionId || "ephemeral").replaceAll(/[^a-zA-Z0-9_-]/g, "_");
			const reportFile = join(reportsDirectory, `${safeSessionId}-${createdAt.replaceAll(/[:.]/g, "-")}.json`);
			const temporaryFile = `${reportFile}.${randomUUID()}.tmp`;
			const report = {
				kind: "tau-cache-debug",
				version: 1,
				createdAt,
				cwd: cwd || ctx.cwd,
				runtimeId,
				sessionId: sessionId || null,
				sessionFile,
				sourceLog: logFile || null,
				summary: {
					requestsObserved: requests.length,
					resultsObserved: results.length,
					cacheMissesObserved: results.filter((result) => result.cacheMiss).length,
					requestsIncluded: selectedRequests.length,
					models: [...new Set(results.map((result) => `${result.provider}/${result.model}`))],
				},
				selection: {
					maxIncidents: MAX_REPORT_INCIDENTS,
					recentRequests: RECENT_REPORT_REQUESTS,
				},
				markers,
				requests: selectedRequests,
				responses: selectedResponses,
				results: selectedResults,
			};
			try {
				await writeFile(temporaryFile, `${JSON.stringify(report, null, "\t")}\n`, { encoding: "utf8", flag: "wx" });
				await rename(temporaryFile, reportFile);
			} catch (error) {
				await unlink(temporaryFile).catch(() => undefined);
				throw error;
			}
			ctx.ui.notify(`Cache debug written: ${reportFile}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId();
		sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		requestSequence = 0;
		turnIndex = null;
		latestPromptState = null;
		awaitingResponses = [];
		turnAttempts = [];
		resetComparison();
		await mkdir(reportsDirectory, { recursive: true });
		logFile = join(directory, `${sessionId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
		const cutoff = Date.now() - RETENTION_MS;
		for (const parent of [directory, reportsDirectory]) {
			for (const entry of await readdir(parent, { withFileTypes: true })) {
				if (
					!entry.isFile() ||
					(!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".json") && !entry.name.endsWith(".tmp"))
				)
					continue;
				const path = join(parent, entry.name);
				if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
			}
		}
		const persisted = await readRecentLogRecords(logFile);
		requests = keepRecent(
			persisted
				.filter((record) => record.kind === "request" && record.version === 2)
				.map((record) => record as unknown as RequestRecord),
		);
		responses = keepRecent(
			persisted
				.filter((record) => record.kind === "response" && record.version === 2)
				.map((record) => record as unknown as ResponseRecord),
		);
		results = keepRecent(
			persisted
				.filter((record) => record.kind === "result" && record.version === 2)
				.map((record) => record as unknown as ResultRecord),
		);
		markers = keepRecent(
			persisted
				.filter((record) => record.kind === "marker" && record.version === 2)
				.map((record) => record as unknown as MarkerRecord),
		);
		let latestModelSelectIndex = -1;
		for (let index = persisted.length - 1; index >= 0; index -= 1) {
			const record = persisted[index];
			if (record?.kind !== "marker" || record.version !== 2 || record.name !== "model-select") continue;
			latestModelSelectIndex = index;
			break;
		}
		const comparisonRecords = persisted.slice(latestModelSelectIndex + 1);
		const comparisonResults = comparisonRecords
			.filter((record) => record.kind === "result" && record.version === 2)
			.map((record) => record as unknown as ResultRecord);
		const latestPromotedResult = [...comparisonResults].reverse().find((result) => result.baselinePromoted);
		const latestRequest = latestPromotedResult
			? requests.find((request) => request.id === latestPromotedResult.id)
			: undefined;
		if (latestPromotedResult && latestRequest) {
			previousFingerprint = payloadFingerprintFromRequest(latestRequest);
			previousRequestId = latestRequest.id;
			previousPromptState = latestRequest.promptState;
			previousPromptTokens = latestPromotedResult.usage.promptTokens;
			cacheActivitySeen = comparisonResults.some(
				(result) => result.baselinePromoted && result.usage.cacheRead + result.usage.cacheWrite > 0,
			);
		}
		await appendRecord({
			kind: "runtime",
			version: 2,
			timestamp: new Date().toISOString(),
			runtimeId,
			cwd,
			sessionId,
			sessionFile,
		});
	});

	pi.on("before_agent_start", (event) => {
		latestPromptState = fingerprintPromptState(event.systemPrompt, event.systemPromptOptions);
	});

	pi.on("turn_start", (event) => {
		turnIndex = event.turnIndex;
		turnAttempts = [];
	});

	pi.on("before_provider_request", async (event) => {
		const unresolvedIds = new Set(
			turnAttempts.filter((attempt) => attempt.responseStatus === undefined).map((attempt) => attempt.id),
		);
		if (unresolvedIds.size > 0) {
			awaitingResponses = awaitingResponses.filter((attempt) => !unresolvedIds.has(attempt.id));
		}
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
		const request: RequestRecord = {
			kind: "request",
			version: 2,
			timestamp: new Date().toISOString(),
			id,
			turnIndex,
			previousRequestId,
			model: fingerprint.model,
			promptCacheKeyHash: fingerprint.promptCacheKeyHash,
			instructionsHash: fingerprint.instructionsHash,
			toolsHash: fingerprint.toolsHash,
			nonSequenceHash: fingerprint.nonSequenceHash,
			sequenceField: fingerprint.sequenceField,
			fields: fingerprint.fields,
			tools: fingerprint.tools,
			items: fingerprint.items,
			previousItems: previousFingerprint?.items.length ?? 0,
			commonPrefixItems,
			stableEnvelope,
			previousExactPrefix,
			previousPromptTokens,
			changes: compareFingerprints(previousFingerprint, fingerprint, previousPromptState, latestPromptState),
			promptState: latestPromptState,
		};
		const attempt: Attempt = { id, fingerprint, request, responseStatus: undefined };
		awaitingResponses.push(attempt);
		turnAttempts.push(attempt);
		requests = keepRecent([...requests, request]);
		await appendRecord(request);
	});

	pi.on("after_provider_response", async (event) => {
		const attempt = awaitingResponses.shift();
		if (!attempt) return;
		attempt.responseStatus = event.status;
		const selectedHeaders = Object.fromEntries(
			Object.entries(event.headers).filter(([name]) => {
				const normalized = name.toLowerCase();
				return normalized.includes("request-id") || normalized === "cf-ray";
			}),
		);
		const response: ResponseRecord = {
			kind: "response",
			version: 2,
			timestamp: new Date().toISOString(),
			id: attempt.id,
			status: event.status,
			headers: selectedHeaders,
		};
		responses = keepRecent([...responses, response]);
		await appendRecord(response);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const attempt = turnAttempts.at(-1);
		const completedAttemptIds = new Set(turnAttempts.map((candidate) => candidate.id));
		awaitingResponses = awaitingResponses.filter((candidate) => !completedAttemptIds.has(candidate.id));
		turnAttempts = [];
		if (!attempt) return;
		const usage = event.message.usage;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const baselinePromoted =
			event.message.stopReason !== "error" &&
			event.message.stopReason !== "aborted" &&
			(attempt.responseStatus === undefined || (attempt.responseStatus >= 200 && attempt.responseStatus < 300));
		const missedTokens =
			baselinePromoted && attempt.request.previousExactPrefix
				? Math.max(0, Math.min(attempt.request.previousPromptTokens, promptTokens) - usage.cacheRead)
				: 0;
		const cacheMiss = baselinePromoted && cacheActivitySeen && missedTokens > CACHE_NOISE_FLOOR;
		const result: ResultRecord = {
			kind: "result",
			version: 2,
			timestamp: new Date().toISOString(),
			id: attempt.id,
			provider: event.message.provider,
			model: event.message.model,
			stopReason: event.message.stopReason,
			usage: {
				input: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				promptTokens,
			},
			previousExactPrefix: attempt.request.previousExactPrefix,
			missedTokens,
			cacheMiss,
			baselinePromoted,
		};
		results = keepRecent([...results, result]);
		if (baselinePromoted) {
			previousFingerprint = attempt.fingerprint;
			previousRequestId = attempt.id;
			previousPromptState = attempt.request.promptState;
			previousPromptTokens = promptTokens;
			cacheActivitySeen ||= usage.cacheRead + usage.cacheWrite > 0;
		}
		await appendRecord(result);
	});

	pi.on("model_select", async (event) => {
		resetComparison();
		await addMarker("model-select", {
			provider: event.model.provider,
			model: event.model.id,
			previousProvider: event.previousModel?.provider ?? null,
			previousModel: event.previousModel?.id ?? null,
			source: event.source,
		});
	});
	pi.on("thinking_level_select", (event) =>
		addMarker("thinking-level-select", { level: event.level, previousLevel: event.previousLevel }),
	);
	pi.on("session_compact", (event) =>
		addMarker("session-compact", {
			reason: event.reason,
			fromExtension: event.fromExtension,
			willRetry: event.willRetry,
		}),
	);
	pi.on("session_tree", () => addMarker("session-tree"));
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "context_prune" && event.toolName !== "load_tools") return;
		return addMarker("cache-affecting-tool", { tool: event.toolName, isError: event.isError });
	});
}

async function readRecentLogRecords(path: string): Promise<Array<Record<string, unknown>>> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "r");
		const size = (await handle.stat()).size;
		const start = Math.max(0, size - MAX_LOG_TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		let text = buffer.toString("utf8");
		if (start > 0) {
			const firstNewline = text.indexOf("\n");
			text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
		}
		const records: Array<Record<string, unknown>> = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const value: unknown = JSON.parse(line);
				if (isRecord(value)) records.push(value);
			} catch {
				// Ignore a partial final record left by an interrupted append.
			}
		}
		return records;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	} finally {
		await handle?.close();
	}
}

function payloadFingerprintFromRequest(request: RequestRecord): PayloadFingerprint {
	return {
		model: request.model,
		promptCacheKeyHash: request.promptCacheKeyHash,
		instructionsHash: request.instructionsHash,
		toolsHash: request.toolsHash,
		nonSequenceHash: request.nonSequenceHash,
		sequenceField: request.sequenceField,
		fields: request.fields,
		tools: request.tools,
		items: request.items,
	};
}

function fingerprintPromptState(systemPrompt: string, options: BuildSystemPromptOptions): PromptState {
	const state = {
		systemPromptHash: hashJson(systemPrompt).hash,
		selectedTools: options.selectedTools ?? [],
		toolSnippetsHash: valueHash(options.toolSnippets),
		promptGuidelinesHash: valueHash(options.promptGuidelines),
		appendSystemPromptHash: valueHash(options.appendSystemPrompt),
		customPromptHash: valueHash(options.customPrompt),
		contextFiles: (options.contextFiles ?? []).map((file) => ({
			path: file.path,
			hash: hashJson(file.content).hash,
		})),
		skills: (options.skills ?? []).map((skill) => {
			const record = skill as unknown as Record<string, unknown>;
			return {
				name: typeof record.name === "string" ? record.name : null,
				path: typeof record.path === "string" ? record.path : null,
			};
		}),
	};
	return { hash: hashJson(state).hash, ...state };
}

function fingerprintPayload(payload: unknown): PayloadFingerprint {
	const record = isRecord(payload) ? payload : {};
	const sequenceField = Array.isArray(record.input) ? "input" : Array.isArray(record.messages) ? "messages" : "none";
	const sequence = sequenceField === "none" ? [] : (record[sequenceField] as unknown[]);
	const nonSequence = Object.fromEntries(Object.entries(record).filter(([key]) => key !== sequenceField));
	const tools = Array.isArray(record.tools)
		? record.tools.map((tool) => {
				const fingerprint = hashJson(tool);
				return { ...fingerprint, name: toolName(tool) };
			})
		: [];
	return {
		model: typeof record.model === "string" ? record.model : null,
		promptCacheKeyHash: valueHash(record.prompt_cache_key),
		instructionsHash: valueHash(record.instructions ?? record.system),
		toolsHash: valueHash(record.tools),
		nonSequenceHash: hashJson(nonSequence).hash,
		sequenceField,
		fields: Object.entries(nonSequence)
			.map(([name, value]) => ({ name, ...hashJson(value) }))
			.sort((left, right) => left.name.localeCompare(right.name)),
		tools,
		items: sequence.map((item) => {
			const fingerprint = hashJson(item);
			const itemRecord = isRecord(item) ? item : {};
			return {
				...fingerprint,
				type: typeof itemRecord.type === "string" ? itemRecord.type : null,
				role: typeof itemRecord.role === "string" ? itemRecord.role : null,
				name: typeof itemRecord.name === "string" ? itemRecord.name : null,
			};
		}),
	};
}

function compareFingerprints(
	previous: PayloadFingerprint | undefined,
	current: PayloadFingerprint,
	previousPromptState: PromptState | null,
	currentPromptState: PromptState | null,
): RequestRecord["changes"] {
	const previousFields = new Map(previous?.fields.map((field) => [field.name, field.hash]) ?? []);
	const currentFields = new Map(current.fields.map((field) => [field.name, field.hash]));
	const envelopeFields = [...new Set([...previousFields.keys(), ...currentFields.keys()])]
		.filter((name) => previousFields.get(name) !== currentFields.get(name))
		.sort();
	const previousTools = namedToolHashes(previous?.tools ?? []);
	const currentTools = namedToolHashes(current.tools);
	const toolsAdded = [...currentTools.keys()].filter((name) => !previousTools.has(name));
	const toolsRemoved = [...previousTools.keys()].filter((name) => !currentTools.has(name));
	const toolsChanged = [...currentTools.keys()].filter(
		(name) => previousTools.has(name) && previousTools.get(name) !== currentTools.get(name),
	);
	let firstChangedItem: number | null = null;
	if (previous) {
		const limit = Math.max(previous.items.length, current.items.length);
		for (let index = 0; index < limit; index += 1) {
			if (previous.items[index]?.hash === current.items[index]?.hash) continue;
			firstChangedItem = index;
			break;
		}
	}
	return {
		envelopeFields,
		toolsAdded,
		toolsRemoved,
		toolsChanged,
		firstChangedItem,
		promptStateChanged:
			previousPromptState !== null &&
			currentPromptState !== null &&
			previousPromptState.hash !== currentPromptState.hash,
	};
}

function namedToolHashes(tools: ToolFingerprint[]): Map<string, string> {
	const named = new Map<string, string>();
	for (const [index, tool] of tools.entries()) named.set(tool.name ?? `<unnamed:${index}>`, tool.hash);
	return named;
}

function toolName(value: unknown): string | null {
	if (!isRecord(value)) return null;
	if (typeof value.name === "string") return value.name;
	if (isRecord(value.function) && typeof value.function.name === "string") return value.function.name;
	return null;
}

function valueHash(value: unknown): string | null {
	return value === undefined ? null : hashJson(value).hash;
}

function hashJson(value: unknown): HashFingerprint {
	const serialized = JSON.stringify(value) ?? "undefined";
	return {
		hash: createHash("sha256").update(serialized).digest("hex"),
		bytes: Buffer.byteLength(serialized, "utf8"),
	};
}

function keepRecent<T>(items: T[]): T[] {
	return items.length <= MAX_MEMORY_RECORDS ? items : items.slice(-MAX_MEMORY_RECORDS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
