import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { searchEvidence } from "./evidence.ts";
import { parseForgetDetails } from "./forget.ts";
import { parseAutoReadDetails, parsePathUpdateDetails, textContent } from "./memory-messages.ts";
import { resolveSearchPath } from "./path-utils.ts";
import type { EvidenceStatus } from "./render-state.ts";

const STUB_OUTDATED = "[outdated]";
const STUB_FORGOTTEN = "[forgotten]";
const STUB_IRRELEVANT = "[irrelevant]";
const SAVINGS_THRESHOLD = 1000;

type AgentMessage = ContextEvent["messages"][number];
type MutableMessage = AgentMessage & Record<string, unknown>;

interface EvidenceItem {
	messageIndex: number;
	toolCallId?: string;
	paths: Set<string>;
	role: "current" | "navigation" | "inventory" | "mutation" | "memory-action";
	textLength: number;
}

export function pruneSearchContext(
	messages: AgentMessage[],
	cwd: string,
): { messages: AgentMessage[]; statuses: Map<string, EvidenceStatus> } {
	const replacements = new Map<number, MutableMessage>();
	const stubs = new Map<number, string>();
	const items: EvidenceItem[] = [];

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index] as MutableMessage | undefined;
		if (!message) continue;
		const evidence = evidenceFromMessage(message, index, cwd);
		if (evidence) {
			if (evidence.role === "current") markOlderSamePaths(items, evidence.paths, stubs, true);
			if (evidence.role === "mutation") markOlderSamePaths(items, evidence.paths, stubs, false);
			items.push(evidence);
		}
		if (message.role === "toolResult" && message.toolName === "forget")
			applyForget(message, index, cwd, items, messages, stubs);
	}

	for (const item of items) {
		if (item.role !== "navigation") continue;
		const laterCurrent = items.filter(
			(candidate) => candidate.messageIndex > item.messageIndex && candidate.role === "current",
		);
		if ([...item.paths].every((path) => laterCurrent.some((candidate) => candidate.paths.has(path))))
			maybeStub(stubs, item.messageIndex, item.textLength, STUB_OUTDATED);
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
		statuses: toolStatuses(stubs, items),
	};
}

function evidenceFromMessage(message: MutableMessage, messageIndex: number, cwd: string): EvidenceItem | undefined {
	const direct = searchEvidence(message.details);
	const autoRead = message.role === "custom" ? parseAutoReadDetails(message.details) : undefined;
	const pathUpdate = message.role === "custom" ? parsePathUpdateDetails(message.details) : undefined;
	const paths = new Set<string>();
	const rawPaths =
		direct?.paths ??
		(autoRead
			? [autoRead.path]
			: (pathUpdate?.changes.flatMap((change) =>
					change.kind === "moved" ? [change.from, change.to] : [change.path],
				) ?? []));
	for (const raw of rawPaths) {
		const path = resolveSearchPath(cwd, raw);
		if (path) paths.add(path);
	}
	if (paths.size === 0 && direct?.role !== "memory-action") return undefined;
	return {
		messageIndex,
		toolCallId: direct?.toolCallId ?? (typeof message.toolCallId === "string" ? message.toolCallId : undefined),
		paths,
		role: direct?.role ?? (autoRead ? "current" : "mutation"),
		textLength: textContent(message.content)?.length ?? 0,
	};
}

function markOlderSamePaths(
	items: EvidenceItem[],
	paths: Set<string>,
	stubs: Map<number, string>,
	currentOnly: boolean,
): void {
	for (const item of items) {
		if (currentOnly && item.role !== "current" && item.role !== "navigation") continue;
		if ([...item.paths].some((path) => paths.has(path)))
			maybeStub(stubs, item.messageIndex, item.textLength, STUB_OUTDATED);
	}
}

function applyForget(
	message: MutableMessage,
	messageIndex: number,
	cwd: string,
	items: EvidenceItem[],
	messages: AgentMessage[],
	stubs: Map<number, string>,
): void {
	const forget = parseForgetDetails(message.details);
	if (!forget) return;
	const stub = forget.disposition === "irrelevant" ? STUB_IRRELEVANT : STUB_FORGOTTEN;
	const paths = new Set(
		(forget.paths ?? []).flatMap((entry) => {
			const path = resolveSearchPath(cwd, entry.path);
			return path ? [path] : [];
		}),
	);
	for (const item of items) {
		if (item.messageIndex >= messageIndex || item.role === "mutation" || item.role === "memory-action") continue;
		if (paths.size > 0 && ![...item.paths].some((path) => paths.has(path))) continue;
		stubs.set(item.messageIndex, stub);
	}
	let recent = Math.max(0, Math.floor(forget.recent ?? 0));
	for (let index = messageIndex - 1; index >= 0 && recent > 0; index -= 1) {
		const candidate = messages[index];
		if (!candidate || !isRecentForgetEligible(candidate)) continue;
		stubs.set(index, stub);
		recent -= 1;
	}
}

function isRecentForgetEligible(message: AgentMessage): boolean {
	const record = message as MutableMessage;
	if (record.role === "toolResult") return record.toolName !== "patch" && record.isError !== true;
	if (record.role !== "bashExecution") return false;
	return record.exitCode === 0 && record.cancelled !== true;
}

function toolStatuses(stubs: Map<number, string>, items: EvidenceItem[]): Map<string, EvidenceStatus> {
	const statuses = new Map<string, EvidenceStatus>();
	for (const item of items) {
		if (!item.toolCallId) continue;
		const stub = stubs.get(item.messageIndex);
		if (stub === STUB_OUTDATED) statuses.set(item.toolCallId, "outdated");
		else if (stub === STUB_FORGOTTEN) statuses.set(item.toolCallId, "forgotten");
		else if (stub === STUB_IRRELEVANT) statuses.set(item.toolCallId, "irrelevant");
	}
	return statuses;
}

function maybeStub(stubs: Map<number, string>, index: number, rawLength: number, stub: string): void {
	if (stub !== STUB_OUTDATED || rawLength - stub.length >= SAVINGS_THRESHOLD) stubs.set(index, stub);
}
