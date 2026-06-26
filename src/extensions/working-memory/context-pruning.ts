import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { type ForgetDetails, normalizeGrepOutputPath } from "./agent-surface.ts";
import { isRecord, parsePathUpdateDetails, parseRereadDetails, textContent } from "./memory-messages.ts";
import type { EvidenceStatus } from "./renderers.ts";
import { normalizeWorkingMemoryPath } from "./repo-scope.ts";

const STUB_SUPERSEDED = "[superseded]";
const STUB_STALE = "[stale]";
const STUB_FORGOTTEN = "[forgotten]";
const SAVINGS_THRESHOLD = 1000;

type AgentMessage = ContextEvent["messages"][number];
type MutableMessage = AgentMessage & Record<string, unknown>;

interface PruneResult {
	messages: AgentMessage[];
	readStatuses: Map<string, EvidenceStatus>;
	grepStatuses: Map<string, EvidenceStatus>;
}

interface ToolCallInfo {
	messageIndex: number;
	contentIndex: number;
	args: Record<string, unknown>;
}

interface PathEvidence {
	messageIndex: number;
	path: string;
	textLength: number;
	epoch: number;
	current: boolean;
	toolCallId?: string;
}

interface GrepEvidence {
	messageIndex: number;
	toolCallId: string;
	args: Record<string, unknown>;
	paths: Set<string>;
	textLength: number;
}

interface PatchResult {
	messageIndex: number;
	toolCallId: string;
	status: "completed" | "partial" | "failed";
	paths: Set<string>;
}

export function pruneWorkingMemoryContext(messages: AgentMessage[], cwd: string): PruneResult {
	const calls = collectToolCalls(messages);
	const replacements = new Map<number, MutableMessage>();
	const stubs = new Map<number, string>();
	const readToolCallIds = new Map<number, string>();
	const grepToolCallIds = new Map<number, string>();
	const latestEpoch = new Map<string, number>();
	const currentEvidencePaths = new Set<string>();
	const reads: PathEvidence[] = [];
	const rereads: PathEvidence[] = [];
	const greps: GrepEvidence[] = [];
	const pathUpdates: Array<{ messageIndex: number; paths: Set<string>; sourceToolCallId: string }> = [];
	const patchResults = new Map<string, PatchResult>();
	let epoch = 0;

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		const custom = customEvidence(message, index, cwd, latestEpoch);
		if (custom?.kind === "reread") {
			supersedeOlderPathEvidence(custom.evidence, reads, rereads, stubs);
			rereads.push(custom.evidence);
			currentEvidencePaths.add(custom.evidence.path);
			continue;
		}
		if (custom?.kind === "path-update") {
			pathUpdates.push(custom);
			for (const path of custom.paths) {
				epoch += 1;
				latestEpoch.set(path, epoch);
				currentEvidencePaths.add(path);
				staleOlderPathEvidence(path, epoch, reads, rereads, stubs);
			}
			continue;
		}

		if (!isToolResult(message)) continue;
		const call = calls.get(message.toolCallId);
		if (!call) continue;
		if (message.toolName === "read") {
			const evidence = readEvidence(message, call.args, index, cwd, latestEpoch);
			if (!evidence) continue;
			readToolCallIds.set(index, evidence.toolCallId ?? message.toolCallId);
			if (evidence.current) {
				supersedeOlderPathEvidence(evidence, reads, rereads, stubs);
				currentEvidencePaths.add(evidence.path);
			}
			reads.push(evidence);
			continue;
		}
		if (message.toolName === "grep") {
			const grep = grepEvidence(message, call.args, index, cwd);
			if (!grep) continue;
			grepToolCallIds.set(index, grep.toolCallId);
			greps.push(grep);
			continue;
		}
		if (message.toolName === "forget") {
			applyForget(message, index, cwd, reads, rereads, greps, messages, stubs);
			continue;
		}
		if (message.toolName === "patch") {
			const patch = patchResult(message, index, cwd);
			if (patch) patchResults.set(patch.toolCallId, patch);
		}
	}

	for (const grep of greps) {
		if (grep.paths.size > 0 && [...grep.paths].every((path) => currentEvidencePaths.has(path)))
			maybeStub(stubs, grep.messageIndex, grep.textLength, STUB_SUPERSEDED);
	}

	for (const patch of patchResults.values()) {
		if (patch.status !== "completed") continue;
		const coveredBySource =
			rereads.some((evidence) => evidence.toolCallId === patch.toolCallId) ||
			pathUpdates.some((update) => update.sourceToolCallId === patch.toolCallId);
		if (!coveredBySource || ![...patch.paths].every((path) => currentEvidencePaths.has(path))) continue;
		stubs.set(patch.messageIndex, STUB_SUPERSEDED);
		const call = calls.get(patch.toolCallId);
		if (call) stubPatchCall(messages, replacements, call);
	}

	for (const [index, stub] of stubs) {
		const message = replacements.get(index) ?? (messages[index] as MutableMessage | undefined);
		if (!message) continue;
		if (message.role === "bashExecution") replacements.set(index, { ...message, output: stub });
		else replacements.set(index, { ...message, content: [{ type: "text", text: stub }] });
	}

	return {
		messages:
			replacements.size === 0 ? messages : messages.map((message, index) => replacements.get(index) ?? message),
		readStatuses: toolStatuses(stubs, readToolCallIds),
		grepStatuses: toolStatuses(stubs, grepToolCallIds),
	};
}

function collectToolCalls(messages: AgentMessage[]): Map<string, ToolCallInfo> {
	const calls = new Map<string, ToolCallInfo>();
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		const message = messages[messageIndex] as MutableMessage | undefined;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
			const block = message.content[contentIndex];
			if (!isRecord(block) || block.type !== "toolCall") continue;
			const id = typeof block.id === "string" ? block.id : undefined;
			const args = isRecord(block.arguments) ? block.arguments : undefined;
			if (id && args) calls.set(id, { messageIndex, contentIndex, args });
		}
	}
	return calls;
}

function readEvidence(
	message: MutableMessage,
	args: Record<string, unknown>,
	messageIndex: number,
	cwd: string,
	latestEpoch: Map<string, number>,
): PathEvidence | undefined {
	const path = normalizeWorkingMemoryPath(cwd, args.path);
	const textLength = textContent(message.content)?.length;
	if (!path || textLength === undefined) return undefined;
	const current = args.offset === undefined && args.limit === undefined && !isTruncated(message.details);
	return {
		messageIndex,
		path,
		textLength,
		epoch: latestEpoch.get(path) ?? 0,
		current,
		toolCallId: String(message.toolCallId),
	};
}

function customEvidence(
	message: AgentMessage,
	messageIndex: number,
	cwd: string,
	latestEpoch: Map<string, number>,
):
	| { kind: "reread"; evidence: PathEvidence }
	| { kind: "path-update"; paths: Set<string>; sourceToolCallId: string; messageIndex: number }
	| undefined {
	const record = message as MutableMessage;
	if (record.role !== "custom") return undefined;
	const reread = parseRereadDetails(record.details);
	if (reread) {
		const path = normalizeWorkingMemoryPath(cwd, reread.path);
		if (!path) return undefined;
		return {
			kind: "reread",
			evidence: {
				messageIndex,
				path,
				textLength: textContent(record.content)?.length ?? reread.byteLength,
				epoch: latestEpoch.get(path) ?? 0,
				current: true,
				toolCallId: reread.sourceToolCallId,
			},
		};
	}
	const update = parsePathUpdateDetails(record.details);
	if (!update) return undefined;
	const paths = new Set<string>();
	for (const change of update.changes) {
		const values = change.kind === "moved" ? [change.from, change.to] : [change.path];
		for (const value of values) {
			const path = normalizeWorkingMemoryPath(cwd, value);
			if (path) paths.add(path);
		}
	}
	return { kind: "path-update", paths, sourceToolCallId: update.sourceToolCallId, messageIndex };
}

function grepEvidence(
	message: MutableMessage,
	args: Record<string, unknown>,
	messageIndex: number,
	cwd: string,
): GrepEvidence | undefined {
	const text = textContent(message.content);
	if (text === undefined || isTruncated(message.details) || text.includes("No matches found")) return undefined;
	const paths = parseGrepPaths(text, cwd, args);
	if (paths.size === 0) return undefined;
	return { messageIndex, toolCallId: String(message.toolCallId), args, paths, textLength: text.length };
}

function patchResult(message: MutableMessage, messageIndex: number, cwd: string): PatchResult | undefined {
	const details = isRecord(message.details) ? message.details : undefined;
	const status = details?.status;
	if (status !== "completed" && status !== "partial" && status !== "failed") return undefined;
	if (!details) return undefined;
	if (!Array.isArray(details.changes)) return undefined;
	const paths = new Set<string>();
	for (const change of details.changes) {
		if (!isRecord(change) || typeof change.path !== "string") return undefined;
		const path = normalizeWorkingMemoryPath(cwd, change.path);
		if (path) paths.add(path);
		if (isRecord(change.move)) {
			const from = normalizeWorkingMemoryPath(cwd, change.move.from);
			const to = normalizeWorkingMemoryPath(cwd, change.move.to);
			if (from) paths.add(from);
			if (to) paths.add(to);
		}
	}
	return { messageIndex, toolCallId: String(message.toolCallId), status, paths };
}

function applyForget(
	message: MutableMessage,
	messageIndex: number,
	cwd: string,
	reads: PathEvidence[],
	rereads: PathEvidence[],
	greps: GrepEvidence[],
	messages: AgentMessage[],
	stubs: Map<number, string>,
): void {
	const directive = parseForgetDetails(message.details, cwd);
	if (!directive) return;
	for (const evidence of [...reads, ...rereads]) {
		const rereadIf = directive.paths.get(evidence.path);
		if (directive.paths.size > 0 && rereadIf === undefined) continue;
		stubs.set(evidence.messageIndex, forgottenStub(rereadIf));
	}
	for (const grep of greps) {
		if (grep.messageIndex > messageIndex) continue;
		if (directive.paths.size > 0 && [...grep.paths].some((path) => !directive.paths.has(path))) continue;
		stubs.set(grep.messageIndex, STUB_FORGOTTEN);
	}
	if (directive.recent > 0) {
		let remaining = directive.recent;
		for (let index = messageIndex - 1; index >= 0 && remaining > 0; index -= 1) {
			const candidate = messages[index];
			if (!candidate || !isRecentForgetEligible(candidate)) continue;
			stubs.set(index, STUB_FORGOTTEN);
			remaining -= 1;
		}
	}
}

function parseForgetDetails(
	details: unknown,
	cwd: string,
): { paths: Map<string, string | undefined>; recent: number } | undefined {
	if (!isRecord(details) || !isRecord(details.workingMemory)) return undefined;
	const wm = details.workingMemory as ForgetDetails["workingMemory"];
	if (wm.version !== 2 || wm.type !== "forget") return undefined;
	const paths = new Map<string, string | undefined>();
	if (Array.isArray(wm.paths)) {
		for (const entry of wm.paths) {
			const path = normalizeWorkingMemoryPath(cwd, entry.path);
			if (path) paths.set(path, entry.rereadIf);
		}
	}
	return { paths, recent: typeof wm.recent === "number" && wm.recent > 0 ? Math.floor(wm.recent) : 0 };
}

function supersedeOlderPathEvidence(
	current: PathEvidence,
	reads: PathEvidence[],
	rereads: PathEvidence[],
	stubs: Map<number, string>,
): void {
	for (const prior of [...reads, ...rereads]) {
		if (prior.path === current.path && prior.messageIndex < current.messageIndex)
			stubs.set(prior.messageIndex, STUB_SUPERSEDED);
	}
}

function staleOlderPathEvidence(
	path: string,
	epoch: number,
	reads: PathEvidence[],
	rereads: PathEvidence[],
	stubs: Map<number, string>,
): void {
	for (const prior of [...reads, ...rereads]) {
		if (prior.path === path && prior.epoch < epoch) stubs.set(prior.messageIndex, STUB_STALE);
	}
}

function parseGrepPaths(text: string, cwd: string, args: Record<string, unknown>): Set<string> {
	const paths = new Set<string>();
	for (const line of text.split("\n")) {
		if (line.trim() === "" || line.startsWith("[")) continue;
		const match = /^(.+?)(?::\d+(?::|\s)|-\d+-\s)/.exec(line);
		if (!match?.[1]) return new Set();
		const path = normalizeGrepOutputPath(cwd, args.path, match[1]);
		if (path) paths.add(path);
	}
	return paths;
}

function stubPatchCall(messages: AgentMessage[], replacements: Map<number, MutableMessage>, call: ToolCallInfo): void {
	const message = replacements.get(call.messageIndex) ?? (messages[call.messageIndex] as MutableMessage | undefined);
	if (!message || !Array.isArray(message.content)) return;
	const content = [...message.content];
	const block = content[call.contentIndex];
	if (!isRecord(block)) return;
	content[call.contentIndex] = { ...block, arguments: { input: STUB_SUPERSEDED } };
	replacements.set(call.messageIndex, { ...message, content });
}

function isRecentForgetEligible(message: AgentMessage): boolean {
	const record = message as MutableMessage;
	if (record.role === "toolResult") return record.toolName !== "patch" && record.isError !== true;
	if (record.role !== "bashExecution") return false;
	return record.exitCode === 0 && record.cancelled !== true;
}

function toolStatuses(stubs: Map<number, string>, toolCallIds: Map<number, string>): Map<string, EvidenceStatus> {
	const statuses = new Map<string, EvidenceStatus>();
	for (const [messageIndex, stub] of stubs) {
		const toolCallId = toolCallIds.get(messageIndex);
		if (!toolCallId) continue;
		if (stub.startsWith(STUB_FORGOTTEN)) statuses.set(toolCallId, "forgotten");
		else if (stub === STUB_STALE) statuses.set(toolCallId, "stale");
		else if (stub === STUB_SUPERSEDED) statuses.set(toolCallId, "superseded");
	}
	return statuses;
}

function maybeStub(stubs: Map<number, string>, index: number, rawLength: number, stub: string): void {
	if (rawLength - stub.length >= SAVINGS_THRESHOLD) stubs.set(index, stub);
}

function forgottenStub(rereadIf: string | undefined): string {
	return rereadIf ? `${STUB_FORGOTTEN}\nOnly reread if ${rereadIf}.` : STUB_FORGOTTEN;
}

function isToolResult(
	message: AgentMessage,
): message is MutableMessage & { role: "toolResult"; toolCallId: string; toolName: string } {
	const record = message as MutableMessage;
	return record.role === "toolResult" && typeof record.toolCallId === "string" && typeof record.toolName === "string";
}

function isTruncated(details: unknown): boolean {
	if (!isRecord(details)) return false;
	return (
		Boolean(details.truncated) ||
		Boolean(details.limitHit) ||
		Boolean(details.hitLimit) ||
		isRecord(details.truncation)
	);
}
