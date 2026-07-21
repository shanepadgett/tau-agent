import { realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { estimateTokens, type ContextEvent } from "@earendil-works/pi-coding-agent";
import { prepareAutoreadMessage, type PreparedAutoreadMessage } from "../explore/autoread.ts";
import { COMPLETE_FILE_SCOPE, MAX_COMPLETE_FILE_SNAPSHOT_BYTES } from "../explore/full-file-knowledge.ts";
import { readMetaFromMessage, replayReadCache } from "../explore/read-cache.ts";

type ContextMessage = ContextEvent["messages"][number];
type ReadEvidenceMessage =
	| Extract<ContextMessage, { role: "toolResult" }>
	| Extract<ContextMessage, { role: "custom" }>;

interface RequestedFile {
	path: string;
	relevance: string;
}

interface RequestedDeferredFile {
	path: string;
	reason: string;
	relevantWhen: string;
}

interface CanonicalFile<T> {
	canonicalPath: string;
	displayPath: string;
	request: T;
}

interface FileEvidenceSelection {
	retainedToolCallIds: ReadonlySet<string>;
	retainedAutoreadRowIds: ReadonlySet<string>;
	preparedSnapshots: readonly PreparedAutoreadMessage[];
	refreshedFiles: readonly { path: string; rowId: string; servedHash: string }[];
}

export async function canonicalizeFileSelections(options: {
	cwd: string;
	keepFiles: readonly RequestedFile[];
	deferFiles: readonly RequestedDeferredFile[];
}): Promise<{
	keepFiles: CanonicalFile<RequestedFile>[];
	deferFiles: CanonicalFile<RequestedDeferredFile>[];
}> {
	const seen = new Map<string, string>();
	const canonicalCwd = await canonicalizePath(resolve(options.cwd));
	const canonicalize = async <T extends { path: string }>(request: T): Promise<CanonicalFile<T>> => {
		const requested = resolve(options.cwd, request.path.replace(/^@/, ""));
		const canonicalPath = await canonicalizePath(requested);
		const previous = seen.get(canonicalPath);
		if (previous !== undefined) {
			throw new Error(`Duplicate file selection: ${request.path} resolves to the same path as ${previous}`);
		}
		seen.set(canonicalPath, request.path);
		const relativePath = relative(canonicalCwd, canonicalPath);
		const displayPath =
			relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)
				? relativePath
				: canonicalPath;
		return { canonicalPath, displayPath, request };
	};

	const keepFiles: CanonicalFile<RequestedFile>[] = [];
	for (const request of options.keepFiles) keepFiles.push(await canonicalize(request));
	const deferFiles: CanonicalFile<RequestedDeferredFile>[] = [];
	for (const request of options.deferFiles) deferFiles.push(await canonicalize(request));
	return { keepFiles, deferFiles };
}

export async function selectFileEvidence(options: {
	cwd: string;
	messages: readonly ContextMessage[];
	files: readonly CanonicalFile<RequestedFile>[];
	anchorToolCallId: string;
	signal: AbortSignal | undefined;
	isLifecycleCurrent: () => boolean;
}): Promise<FileEvidenceSelection> {
	const entries = options.messages.map((message) =>
		message.role === "custom" ? { type: "custom_message", ...message } : { type: "message", message },
	);
	const replay = replayReadCache(entries, options.cwd);
	const retainedToolCallIds = new Set<string>();
	const retainedAutoreadRowIds = new Set<string>();
	const preparedSnapshots: PreparedAutoreadMessage[] = [];
	const refreshedFiles: Array<{ path: string; rowId: string; servedHash: string }> = [];
	const rowMessages = indexEvidenceRows(options.messages);

	for (let fileIndex = 0; fileIndex < options.files.length; fileIndex += 1) {
		const file = options.files[fileIndex];
		if (!file) continue;
		options.signal?.throwIfAborted();
		if (!options.isLifecycleCurrent()) throw new Error("Prune preparation crossed a session lifecycle boundary");

		const rawRows: ContextMessage[] = [];
		for (const message of options.messages) {
			const pathKey = rawReadPath(message, options.cwd);
			if (pathKey && (await canonicalizePath(pathKey)) === file.canonicalPath) rawRows.push(message);
		}
		if (rawRows.length === 0) throw new Error(`${file.displayPath} has no prior read evidence; read the file first`);
		const rawCompleteRows = rawRows.filter((message) => rawScopeKey(message) === COMPLETE_FILE_SCOPE);
		if (rawCompleteRows.length === 0) {
			throw new Error(`${file.displayPath} has only partial read evidence; read the complete file first`);
		}
		const acceptedRows: Array<(typeof replay.acceptedRows)[number]> = [];
		for (const row of replay.acceptedRows) {
			if (row.scopeKey === COMPLETE_FILE_SCOPE && (await canonicalizePath(row.pathKey)) === file.canonicalPath)
				acceptedRows.push(row);
		}
		if (acceptedRows.length === 0) {
			throw new Error(`${file.displayPath} has malformed complete-file evidence; read the file again`);
		}

		const rowId = `${options.anchorToolCallId}:${fileIndex}`;
		const prepared = await prepareAutoreadMessage({
			rowId,
			path: file.displayPath,
			cwd: options.cwd,
			source: "context-pruning",
			batchId: options.anchorToolCallId,
			signal: options.signal,
			isLifecycleCurrent: options.isLifecycleCurrent,
			maximumBytes: MAX_COMPLETE_FILE_SNAPSHOT_BYTES,
		});
		const currentHash = prepared.details.readCache.servedHash;
		const unchangedBaseline = acceptedRows.find(
			(row) => (row.meta.mode === "baseline" || row.meta.mode === "recovery") && row.meta.servedHash === currentHash,
		);
		if (unchangedBaseline) {
			retainRows(unchangedBaseline.dependencyRowIds, rowMessages, retainedToolCallIds, retainedAutoreadRowIds);
			continue;
		}

		let chain = replay.completeFileChains.get(file.canonicalPath);
		if (!chain) {
			for (const candidate of replay.completeFileChains.values()) {
				if ((await canonicalizePath(candidate.pathKey)) === file.canonicalPath) {
					chain = candidate;
					break;
				}
			}
		}
		if (chain?.servedHash === currentHash) {
			const chainCost = chain.rowIds.reduce((total, id) => total + (rowMessages.get(id)?.tokens ?? 0), 0);
			const snapshotCost = estimatePreparedSnapshot(prepared);
			if (chainCost <= snapshotCost) {
				retainRows(chain.rowIds, rowMessages, retainedToolCallIds, retainedAutoreadRowIds);
				continue;
			}
		}

		preparedSnapshots.push(prepared);
		retainedAutoreadRowIds.add(rowId);
		refreshedFiles.push({ path: file.displayPath, rowId, servedHash: currentHash });
	}

	return { retainedToolCallIds, retainedAutoreadRowIds, preparedSnapshots, refreshedFiles };
}

function indexEvidenceRows(
	messages: readonly ContextMessage[],
): Map<string, { tokens: number; kind: "tool" | "autoread" }> {
	const rows = new Map<string, { tokens: number; kind: "tool" | "autoread" }>();
	const calls = new Map<string, { message: Extract<ContextMessage, { role: "assistant" }>; blockIndex: number }>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
				const block = message.content[blockIndex];
				if (block?.type === "toolCall") calls.set(block.id, { message, blockIndex });
			}
			continue;
		}
		if (message.role === "toolResult" && message.toolName === "read") {
			const call = calls.get(message.toolCallId);
			const block = call?.message.content[call.blockIndex];
			if (call && block?.type === "toolCall") {
				rows.set(message.toolCallId, {
					tokens: estimateTokens({ ...call.message, content: [block] }) + estimateTokens(message),
					kind: "tool",
				});
			}
			continue;
		}
		if (message.role === "custom" && message.customType === "tau.autoread") {
			const rowId = autoreadRowId(message);
			if (rowId) rows.set(rowId, { tokens: estimateTokens(message), kind: "autoread" });
		}
	}
	return rows;
}

function retainRows(
	rowIds: readonly string[],
	rows: ReadonlyMap<string, { kind: "tool" | "autoread" }>,
	toolIds: Set<string>,
	autoreadIds: Set<string>,
): void {
	for (const rowId of rowIds) {
		const row = rows.get(rowId);
		if (!row) throw new Error(`Complete-file dependency row is absent from projected context: ${rowId}`);
		if (row.kind === "tool") toolIds.add(rowId);
		else autoreadIds.add(rowId);
	}
}

function estimatePreparedSnapshot(prepared: PreparedAutoreadMessage): number {
	const message: ContextMessage = {
		role: "custom",
		customType: prepared.customType,
		content: prepared.content,
		display: prepared.display,
		details: prepared.details,
		timestamp: 0,
	};
	return estimateTokens(message);
}

function rawReadPath(message: ContextMessage, cwd: string): string | undefined {
	const meta = readMetaFromMessage(message);
	if (meta) return resolve(cwd, meta.pathKey);
	if (!isReadEvidence(message) || !isRecord(message.details) || !isRecord(message.details.readCache)) return undefined;
	const pathKey = message.details.readCache.pathKey;
	return typeof pathKey === "string" ? resolve(cwd, pathKey) : undefined;
}

function rawScopeKey(message: ContextMessage): string | undefined {
	if (!isReadEvidence(message) || !isRecord(message.details) || !isRecord(message.details.readCache)) return undefined;
	return typeof message.details.readCache.scopeKey === "string" ? message.details.readCache.scopeKey : undefined;
}

function isReadEvidence(message: ContextMessage): message is ReadEvidenceMessage {
	return (
		(message.role === "toolResult" && message.toolName === "read") ||
		(message.role === "custom" && message.customType === "tau.autoread")
	);
}

function autoreadRowId(message: ContextMessage): string | undefined {
	if (message.role !== "custom" || !isRecord(message.details)) return undefined;
	return typeof message.details.rowId === "string" ? message.details.rowId : undefined;
}

function isMissingPathError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

async function canonicalizePath(path: string): Promise<string> {
	const missingSegments: string[] = [];
	let cursor = path;
	while (true) {
		try {
			const canonicalAncestor = await realpath(cursor);
			return resolve(canonicalAncestor, ...missingSegments.reverse());
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(cursor);
			if (parent === cursor) return path;
			missingSegments.push(basename(cursor));
			cursor = parent;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
