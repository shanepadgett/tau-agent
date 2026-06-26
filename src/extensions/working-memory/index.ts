import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import {
	buildSessionContext,
	type ContextEvent,
	createGrepToolDefinition,
	createReadToolDefinition,
	defineTool,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { onTauEvent, type TauAgentEvents } from "../../shared/events.js";
import { type LineRange, mergeLineRanges } from "../../shared/ranges.js";

const SAVINGS_THRESHOLD = 1000;
const STUB_SUPERSEDED = "[superseded]";
const STUB_STALE = "[stale]";
const STUB_FORGOTTEN = "[forgotten]";
const CUSTOM_TYPE = "tau.working-memory.snapshot";
const SNAPSHOT_CONTEXT_LINES = 3;
const SNAPSHOT_MAX_LINES = 120;

const WORKING_MEMORY_GUIDANCE = [
	"Working memory prunes only outbound model context; raw session history and /tree stay intact.",
	"For likely-relevant files, read the whole file first when practical. If grep shows [loc: path:count], whole-file reads under about 600 lines are usually fine; skip huge/generated/vendor files unless required.",
	"After broad reads, batch focused rereads for the spans you actually need. Use generous function-sized ranges with buffer; exact boundaries are not required.",
	"Focused rereads let older broad reads become [superseded]. Use the most recent focused reads as the evidence you carry forward.",
	"Call forget when exploration is irrelevant or no longer needed: mode=paths for irrelevant files, mode=safe_exploration after broad exploration once focused evidence remains.",
	"After patch, rely on visible patch snapshots as current evidence unless broader current file context is needed.",
];

const forgetParams = Type.Object({
	keep: Type.String({ description: "Short retained working-memory checkpoint." }),
	mode: Type.Optional(
		Type.Union([Type.Literal("superseded_reads"), Type.Literal("safe_exploration"), Type.Literal("paths")]),
	),
	paths: Type.Optional(Type.Array(Type.String())),
});

type ForgetMode = "superseded_reads" | "safe_exploration" | "paths";

interface ToolCallInfo {
	messageIndex: number;
	contentIndex: number;
	args: Record<string, unknown>;
}

interface Range extends LineRange {}

interface ReadEvidence {
	messageIndex: number;
	toolCallId: string;
	path: string;
	range: Range;
	textLength: number;
	epoch: number;
}

interface SnapshotEvidence {
	messageIndex: number;
	sourceToolCallId?: string;
	path: string;
	state: "present" | "deleted";
	ranges: Range[];
	textLength: number;
	epoch: number;
}

interface PatchResult {
	messageIndex: number;
	toolCallId: string;
	status: "completed" | "partial" | "failed";
	changes: Array<{ path: string; kind: string }>;
	textLength: number;
}

interface ForgetDirective {
	mode: ForgetMode;
	paths: Set<string> | undefined;
}

interface SnapshotDetails {
	workingMemory:
		| {
				version: 1;
				type: "mutation-snapshot";
				sourceToolCallId: string;
				toolName: "patch";
				path: string;
				state: "present" | "deleted";
				ranges: Range[];
		  }
		| {
				version: 1;
				type: "context-snapshot";
				source: "tau-edit";
				batchId: string;
				path: string;
				state: "present";
				ranges: Range[];
		  };
}

type MutationEvent = TauAgentEvents["tau:file-mutation.applied"];
type ContextSnapshotEvent = TauAgentEvents["tau:context.snapshot"];
type AgentMessage = ContextEvent["messages"][number];
type MutableMessage = AgentMessage & Record<string, unknown>;
type ReadStatus = "superseded" | "stale" | "forgotten";

let latestReadStatuses = new Map<string, ReadStatus>();
let latestGrepStatuses = new Map<string, ReadStatus>();
const sentSnapshotKeys = getSentSnapshotKeys();

class ReadCallComponent implements Component {
	private readonly args: { path?: unknown; offset?: unknown; limit?: unknown };
	private readonly theme: Theme;
	private readonly toolCallId: string;

	constructor(args: { path?: unknown; offset?: unknown; limit?: unknown }, theme: Theme, toolCallId: string) {
		this.args = args;
		this.theme = theme;
		this.toolCallId = toolCallId;
	}

	render(): string[] {
		const path = typeof this.args.path === "string" ? this.args.path : "";
		const range = formatReadArgs(this.args);
		const status = latestReadStatuses.get(this.toolCallId);
		const suffix = status ? ` ${this.theme.fg("muted", `[${status}]`)}` : "";
		return [
			`${this.theme.fg("toolTitle", this.theme.bold("read"))} ${this.theme.fg("muted", path)}${range}${suffix}`,
		];
	}

	invalidate(): void {}
}

class GrepCallComponent implements Component {
	private readonly args: {
		pattern?: unknown;
		path?: unknown;
		glob?: unknown;
		limit?: unknown;
	};
	private readonly theme: Theme;
	private readonly toolCallId: string;

	constructor(
		args: { pattern?: unknown; path?: unknown; glob?: unknown; limit?: unknown },
		theme: Theme,
		toolCallId: string,
	) {
		this.args = args;
		this.theme = theme;
		this.toolCallId = toolCallId;
	}

	render(): string[] {
		const pattern = typeof this.args.pattern === "string" ? this.args.pattern : "";
		const path = typeof this.args.path === "string" && this.args.path ? this.args.path : ".";
		const glob = typeof this.args.glob === "string" && this.args.glob ? ` ${this.args.glob}` : "";
		const limit = typeof this.args.limit === "number" ? ` limit=${this.args.limit}` : "";
		const status = latestGrepStatuses.get(this.toolCallId);
		const suffix = status ? ` ${this.theme.fg("muted", `[${status}]`)}` : "";
		return [
			`${this.theme.fg("toolTitle", this.theme.bold("grep"))} ${this.theme.fg("accent", `/${pattern}/`)} ${this.theme.fg("muted", path)}${this.theme.fg("muted", glob)}${this.theme.fg("muted", limit)}${suffix}`,
		];
	}

	invalidate(): void {}
}

const readParams = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const grepParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

class SnapshotComponent implements Component {
	private readonly message: { content: unknown; details?: SnapshotDetails };
	private readonly expanded: boolean;
	private readonly theme: Theme;

	constructor(message: { content: unknown; details?: SnapshotDetails }, expanded: boolean, theme: Theme) {
		this.message = message;
		this.expanded = expanded;
		this.theme = theme;
	}

	render(): string[] {
		const details = this.message.details?.workingMemory;
		const path = details?.path ?? "mutation snapshot";
		const suffix = details?.state === "deleted" ? " deleted" : formatRanges(details?.ranges ?? []);
		const source = details?.type === "context-snapshot" ? details.source : "patch";
		const header = `${this.theme.fg("toolTitle", this.theme.bold("snapshot"))} ${this.theme.fg("muted", path)}${this.theme.fg("muted", suffix)} ${this.theme.fg("muted", `[${source}]`)}`;
		if (!this.expanded) return [header];
		const content =
			typeof this.message.content === "string" ? this.message.content : (textContent(this.message.content) ?? "");
		return `${header}\n${content}`.split("\n");
	}

	invalidate(): void {}
}

const FORGET_TOOL = defineTool<
	typeof forgetParams,
	{ workingMemory: { version: 1; mode: ForgetMode; paths?: string[] } }
>({
	name: "forget",
	label: "Forget",
	description:
		"Retain a short working-memory checkpoint and stub prior successful reads or grep results that are no longer needed. Use it to actively manage context after irrelevant exploration not handled by automatic stubbing.",
	promptSnippet:
		"Use forget to actively prune irrelevant exploration once the surviving facts fit in a short checkpoint.",
	promptGuidelines: [
		"Actively manage context. If you read files or grep output that are irrelevant to the current work and automatic stubbing will not remove them, call forget.",
		"When a file is not required for the task, use forget mode=paths for that file instead of carrying dead evidence forward.",
		"Put the reason in keep once, such as which explored files were irrelevant and what evidence remains relevant. Old outputs become tiny stubs only.",
		"Use focused reads after broad reads to retain exact evidence.",
		"After grep, read the matched files that matter.",
		"After patch, rely on injected per-file snapshots as current evidence; read again only when broader current context is needed.",
		"Use forget after exploration when the surviving facts and discard reasons fit in keep.",
		"Do not call forget only to erase tiny outputs.",
		"Never forget user requirements, active decisions, mutation results, failed checks, or unresolved errors.",
		"If unsure, keep it.",
	],
	parameters: forgetParams,
	executionMode: "sequential",
	async execute(_toolCallId, params) {
		const mode = params.mode ?? "superseded_reads";
		const paths = params.paths?.filter((path) => path.trim().length > 0);
		return {
			content: [{ type: "text", text: `Working memory retained:\n${params.keep}` }],
			details: { workingMemory: { version: 1, mode, paths } },
		};
	},
});

export default function workingMemory(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "Read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createReadToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new ReadCallComponent(args, theme, context.toolCallId);
		},
	});
	pi.registerTool({
		name: "grep",
		label: "grep",
		description:
			"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Appends compact [loc: path:lineCount] metadata for matched files when available.",
		promptSnippet:
			"Search file contents for patterns (respects .gitignore); grep may append [loc: path:lineCount] for matched files",
		promptGuidelines: [
			"Use grep for broad content search across directories before reading files. Prefer one targeted grep call with path, glob, context, and limit over many single-file searches.",
			"Use glob to narrow file types, literal=true for exact identifiers or strings, and context when nearby code matters.",
			"Avoid grepping one small known file; read it instead unless output would be huge.",
			"Use grep [loc: path:lineCount] metadata to decide whether to read whole files or focused ranges.",
		],
		parameters: grepParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await createGrepToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
			return appendGrepLocFooter(result, params, ctx.cwd);
		},
		renderCall(args, theme, context) {
			return new GrepCallComponent(args, theme, context.toolCallId);
		},
	});
	pi.registerTool(FORGET_TOOL);
	pi.registerMessageRenderer<SnapshotDetails>(CUSTOM_TYPE, (message, options, theme) => {
		return new SnapshotComponent(message, options.expanded, theme);
	});

	const unsubscribeMutationEvent = onTauEvent(pi, "tau:file-mutation.applied", (event) => {
		void sendPatchSnapshots(pi, event);
	});
	const unsubscribeContextSnapshotEvent = onTauEvent(pi, "tau:context.snapshot", (event) => {
		sendContextSnapshots(pi, event);
	});
	pi.on("session_shutdown", () => {
		unsubscribeMutationEvent();
		unsubscribeContextSnapshotEvent();
	});

	pi.on("session_start", (_event, ctx) => {
		const { messages } = buildSessionContext(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
		pruneContext(messages, ctx.cwd);
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nWorking memory:\n${WORKING_MEMORY_GUIDANCE.map((line) => `- ${line}`).join("\n")}`,
	}));

	pi.on("context", (event, ctx) => ({ messages: pruneContext(event.messages, ctx.cwd) }));
}

async function appendGrepLocFooter(
	result: Awaited<ReturnType<ReturnType<typeof createGrepToolDefinition>["execute"]>>,
	params: { path?: string },
	cwd: string,
) {
	const text = textContent(result.content);
	if (!text || text === "No matches found") return result;
	const footer = await grepLocFooter(text, params.path, cwd);
	if (!footer) return result;
	return { ...result, content: [{ type: "text" as const, text: `${text}\n${footer}` }] };
}

async function grepLocFooter(
	text: string,
	rawSearchPath: string | undefined,
	cwd: string,
): Promise<string | undefined> {
	const searchPath = normalizePath(cwd, rawSearchPath ?? ".");
	if (!searchPath) return undefined;
	const searchPathIsDirectory = await stat(searchPath)
		.then((value) => value.isDirectory())
		.catch(() => undefined);
	if (searchPathIsDirectory === undefined) return undefined;

	const paths = grepOutputPaths(text);
	const entries: string[] = [];
	for (const path of paths) {
		const absolutePath = searchPathIsDirectory ? resolve(searchPath, path) : searchPath;
		const lineCount = await readFileLineCount(absolutePath);
		if (lineCount !== undefined) entries.push(`${path}:${lineCount}`);
	}
	return entries.length > 0 ? `[loc: ${entries.join(", ")}]` : undefined;
}

function grepOutputPaths(text: string): string[] {
	const paths = new Set<string>();
	for (const line of text.split("\n")) {
		if (line.startsWith("[") || line.trim() === "") continue;
		const match = /^(.+?)(?::\d+:|-\d+- )/.exec(line);
		if (match) paths.add(match[1]!);
	}
	return [...paths];
}

function formatRanges(ranges: Range[]): string {
	if (ranges.length === 0) return "";
	return ` ${ranges.map((range) => `${range.startLine}-${range.endLine}`).join(",")}`;
}

async function readFileLineCount(path: string): Promise<number | undefined> {
	const text = await readFile(path, "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	return splitLines(text).length;
}

async function sendPatchSnapshots(pi: ExtensionAPI, event: MutationEvent): Promise<void> {
	if (event.source !== "patch" || event.status !== "completed") return;

	for (const change of event.changes) {
		const path = change.path;
		if (change.kind === "delete") {
			const key = snapshotKey(event.toolCallId, path, "deleted", []);
			if (sentSnapshotKeys.has(key)) continue;
			sentSnapshotKeys.add(key);
			pi.sendMessage<SnapshotDetails>(
				{
					customType: CUSTOM_TYPE,
					content: `${path}:deleted`,
					display: true,
					details: snapshotDetails(event.toolCallId, path, "deleted", []),
				},
				{ deliverAs: "steer" },
			);
			continue;
		}

		const absolutePath = normalizePath(event.cwd, path);
		if (!absolutePath) return;
		const text = await readFile(absolutePath, "utf8").catch(() => undefined);
		if (text === undefined) return;
		const lines = splitLines(text);
		const ranges = expandRanges(change.snapshotRanges, lines.length);
		if (ranges.length === 0) return;
		const key = snapshotKey(event.toolCallId, path, "present", ranges);
		if (sentSnapshotKeys.has(key)) continue;
		sentSnapshotKeys.add(key);
		pi.sendMessage<SnapshotDetails>(
			{
				customType: CUSTOM_TYPE,
				content: renderSnapshot(path, ranges, lines),
				display: true,
				details: snapshotDetails(event.toolCallId, path, "present", ranges),
			},
			{ deliverAs: "steer" },
		);
	}
}

function sendContextSnapshots(pi: ExtensionAPI, event: ContextSnapshotEvent): void {
	for (const file of event.files) {
		const lines = splitLines(file.content);
		const ranges = lines.length > 0 ? [{ startLine: 1, endLine: lines.length }] : [];
		pi.sendMessage<SnapshotDetails>(
			{
				customType: CUSTOM_TYPE,
				content: renderContextSnapshot(file.path, file.content, ranges),
				display: true,
				details: contextSnapshotDetails(event.batchId, file.path, ranges),
			},
			{ ...(event.deliverAs ? { deliverAs: event.deliverAs } : {}) },
		);
	}
}

function getSentSnapshotKeys(): Set<string> {
	const key = Symbol.for("tau.working-memory.sentSnapshotKeys");
	const globalStore = globalThis as Record<PropertyKey, unknown>;
	const existing = globalStore[key];
	if (existing instanceof Set) return existing as Set<string>;
	const created = new Set<string>();
	globalStore[key] = created;
	return created;
}

function snapshotKey(toolCallId: string, path: string, state: "present" | "deleted", ranges: Range[]): string {
	return `${toolCallId}\u0000${path}\u0000${state}\u0000${ranges.map((range) => `${range.startLine}-${range.endLine}`).join(",")}`;
}

function pruneContext(messages: AgentMessage[], cwd: string): AgentMessage[] {
	const calls = collectToolCalls(messages);
	const replacements = new Map<number, MutableMessage>();
	const stubs = new Map<number, string>();
	const patchResults = new Map<string, PatchResult>();
	const patchSnapshots = new Map<string, SnapshotEvidence[]>();
	const greps: Array<{ message: MutableMessage; messageIndex: number; args: Record<string, unknown> }> = [];
	const readToolCallIds = new Map<number, string>();
	const grepToolCallIds = new Map<number, string>();
	const latestEpoch = new Map<string, number>();
	const reads: ReadEvidence[] = [];
	const snapshots: SnapshotEvidence[] = [];
	let epoch = 0;

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]!;

		const snapshot = snapshotEvidence(message, index, cwd, latestEpoch);
		if (snapshot) {
			snapshots.push(snapshot);
			if (snapshot.sourceToolCallId) {
				const existing = patchSnapshots.get(snapshot.sourceToolCallId) ?? [];
				existing.push(snapshot);
				patchSnapshots.set(snapshot.sourceToolCallId, existing);
			}
			continue;
		}

		if (!isToolResult(message) || message.isError) continue;
		const call = calls.get(message.toolCallId);
		if (!call) continue;

		if (message.toolName === "read") {
			const read = readEvidence(message, call.args, index, cwd, latestEpoch);
			if (!read) continue;
			readToolCallIds.set(index, read.toolCallId);
			for (const earlier of reads) {
				if (earlier.path !== read.path || earlier.epoch !== read.epoch) continue;
				if (!containsRange(earlier.range, read.range) || rangeSize(earlier.range) <= rangeSize(read.range))
					continue;
				maybeStub(stubs, earlier.messageIndex, earlier.textLength, STUB_SUPERSEDED);
			}
			for (const priorSnapshot of snapshots) {
				if (priorSnapshot.path !== read.path || priorSnapshot.epoch !== read.epoch) continue;
				if (
					priorSnapshot.state === "present" &&
					priorSnapshot.ranges.every((range) => containsRange(read.range, range))
				) {
					maybeStub(stubs, priorSnapshot.messageIndex, priorSnapshot.textLength, STUB_SUPERSEDED);
				}
			}
			reads.push(read);
			continue;
		}

		if (message.toolName === "grep") {
			grepToolCallIds.set(index, String(message.toolCallId));
			greps.push({ message, messageIndex: index, args: call.args });
			continue;
		}

		if (message.toolName === "forget") {
			applyForget(message, index, cwd, reads, greps, snapshots, stubs);
			continue;
		}

		const mutationPaths = mutationPathsFromResult(message, calls.get(message.toolCallId)?.args, cwd);
		if (mutationPaths.length > 0) {
			epoch += 1;
			for (const path of mutationPaths) {
				latestEpoch.set(path, epoch);
				for (const read of reads) {
					if (read.path === path && read.epoch < epoch) stubs.set(read.messageIndex, STUB_STALE);
				}
				for (const priorSnapshot of snapshots) {
					if (priorSnapshot.path === path && priorSnapshot.epoch < epoch)
						stubs.set(priorSnapshot.messageIndex, STUB_STALE);
				}
			}
		}

		if (message.toolName === "patch") {
			const patch = patchResult(message, index, cwd);
			if (patch) patchResults.set(message.toolCallId, patch);
		}
	}

	for (const grep of greps) {
		stubSupersededGrep(grep.message, grep.messageIndex, grep.args, cwd, reads, latestEpoch, stubs);
	}

	for (const patch of patchResults.values()) {
		const snapshotsForPatch = patchSnapshots.get(patch.toolCallId) ?? [];
		if (patch.status !== "completed" || !patchCovered(patch, snapshotsForPatch, cwd)) continue;
		stubs.set(patch.messageIndex, STUB_SUPERSEDED);
		const call = calls.get(patch.toolCallId);
		if (call) stubPatchCall(messages, replacements, call);
	}

	for (const [index, stub] of stubs) {
		const message = replacements.get(index) ?? (messages[index] as MutableMessage | undefined);
		if (!message) continue;
		replacements.set(index, { ...message, content: [{ type: "text", text: stub }] });
	}
	latestReadStatuses = toolStatuses(stubs, readToolCallIds);
	latestGrepStatuses = toolStatuses(stubs, grepToolCallIds);

	if (replacements.size === 0) return messages;
	return messages.map((message, index) => replacements.get(index) ?? message);
}

function formatReadArgs(args: { offset?: unknown; limit?: unknown }): string {
	const parts: string[] = [];
	if (typeof args.offset === "number") parts.push(`offset=${args.offset}`);
	if (typeof args.limit === "number") parts.push(`limit=${args.limit}`);
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function toolStatuses(stubs: Map<number, string>, toolCallIds: Map<number, string>): Map<string, ReadStatus> {
	const statuses = new Map<string, ReadStatus>();
	for (const [messageIndex, stub] of stubs) {
		const toolCallId = toolCallIds.get(messageIndex);
		const status = readStatusFromStub(stub);
		if (toolCallId && status) statuses.set(toolCallId, status);
	}
	return statuses;
}

function readStatusFromStub(stub: string): ReadStatus | undefined {
	if (stub === STUB_SUPERSEDED) return "superseded";
	if (stub === STUB_STALE) return "stale";
	if (stub === STUB_FORGOTTEN) return "forgotten";
	return undefined;
}

function collectToolCalls(messages: AgentMessage[]): Map<string, ToolCallInfo> {
	const calls = new Map<string, ToolCallInfo>();
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		const message = messages[messageIndex] as MutableMessage;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
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
): ReadEvidence | undefined {
	const path = normalizePath(cwd, args.path);
	const range = readRange(args, message.details, message.content);
	const text = textContentLength(message.content);
	if (!path || !range || text === undefined) return undefined;
	return {
		messageIndex,
		toolCallId: String(message.toolCallId),
		path,
		range,
		textLength: text,
		epoch: latestEpoch.get(path) ?? 0,
	};
}

function readRange(args: Record<string, unknown>, details: unknown, content: unknown): Range | undefined {
	const offset = optionalPositiveInt(args.offset) ?? 1;
	if (args.offset !== undefined && optionalPositiveInt(args.offset) === undefined) return undefined;
	const limit = optionalPositiveInt(args.limit);
	if (args.limit !== undefined && limit === undefined) return undefined;
	const outputLines = truncationOutputLines(details);
	const count = outputLines ?? limit ?? displayedLineCount(content);
	if (count === undefined) return undefined;
	return { startLine: offset, endLine: offset + count - 1 };
}

function displayedLineCount(content: unknown): number | undefined {
	const text = textContent(content);
	if (text === undefined) return undefined;
	const lines = splitLines(text).length;
	return lines > 0 ? lines : undefined;
}

function snapshotEvidence(
	message: AgentMessage,
	messageIndex: number,
	cwd: string,
	latestEpoch: Map<string, number>,
): SnapshotEvidence | undefined {
	const record = message as MutableMessage;
	if (record.role !== "custom" || record.customType !== CUSTOM_TYPE) return undefined;
	const details = snapshotDetailsFromUnknown(record.details);
	const text = typeof record.content === "string" ? record.content.length : textContentLength(record.content);
	if (!details || text === undefined) return undefined;
	const path = normalizePath(cwd, details.path);
	if (!path) return undefined;
	return {
		messageIndex,
		...(details.type === "mutation-snapshot" ? { sourceToolCallId: details.sourceToolCallId } : {}),
		path,
		state: details.state,
		ranges: details.ranges,
		textLength: text,
		epoch: latestEpoch.get(path) ?? 0,
	};
}

function snapshotDetailsFromUnknown(value: unknown): SnapshotDetails["workingMemory"] | undefined {
	if (!isRecord(value) || !isRecord(value.workingMemory)) return undefined;
	const wm = value.workingMemory;
	if (wm.version !== 1) return undefined;
	if (wm.type === "context-snapshot") {
		if (wm.source !== "tau-edit" || typeof wm.batchId !== "string" || typeof wm.path !== "string") return undefined;
		if (wm.state !== "present") return undefined;
		if (!Array.isArray(wm.ranges)) return undefined;
		const ranges = parseRanges(wm.ranges);
		if (ranges.length !== wm.ranges.length) return undefined;
		return {
			version: 1,
			type: "context-snapshot",
			source: wm.source,
			batchId: wm.batchId,
			path: wm.path,
			state: wm.state,
			ranges,
		};
	}
	if (wm.type !== "mutation-snapshot" || wm.toolName !== "patch") return undefined;
	if (typeof wm.sourceToolCallId !== "string" || typeof wm.path !== "string") return undefined;
	if (wm.state !== "present" && wm.state !== "deleted") return undefined;
	if (!Array.isArray(wm.ranges)) return undefined;
	const ranges = parseRanges(wm.ranges);
	if (ranges.length !== wm.ranges.length) return undefined;
	return {
		version: 1,
		type: "mutation-snapshot",
		sourceToolCallId: wm.sourceToolCallId,
		toolName: "patch",
		path: wm.path,
		state: wm.state,
		ranges,
	};
}

function patchResult(message: MutableMessage, messageIndex: number, cwd: string): PatchResult | undefined {
	const details = isRecord(message.details) ? message.details : undefined;
	const status = details?.status;
	if (status !== "completed" && status !== "partial" && status !== "failed") return undefined;
	const rawChanges = details?.changes;
	if (!Array.isArray(rawChanges)) return undefined;
	const changes: PatchResult["changes"] = [];
	for (const change of rawChanges) {
		if (!isRecord(change) || typeof change.path !== "string" || typeof change.kind !== "string") return undefined;
		const path = normalizePath(cwd, change.path);
		if (!path) return undefined;
		changes.push({ path, kind: change.kind });
	}
	const textLength = textContentLength(message.content);
	if (textLength === undefined) return undefined;
	return { messageIndex, toolCallId: String(message.toolCallId), status, changes, textLength };
}

function mutationPathsFromResult(
	message: MutableMessage,
	args: Record<string, unknown> | undefined,
	cwd: string,
): string[] {
	if (message.toolName === "patch") {
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details || !Array.isArray(details.changes)) return [];
		return (details.changes as unknown[]).flatMap((change) => {
			if (!isRecord(change) || typeof change.path !== "string") return [];
			const path = normalizePath(cwd, change.path);
			return path ? [path] : [];
		});
	}
	if (message.toolName !== "write" && message.toolName !== "edit") return [];
	const path = normalizePath(cwd, args?.path);
	return path ? [path] : [];
}

function stubSupersededGrep(
	message: MutableMessage,
	messageIndex: number,
	args: Record<string, unknown>,
	cwd: string,
	reads: ReadEvidence[],
	latestEpoch: Map<string, number>,
	stubs: Map<number, string>,
): void {
	const text = textContent(message.content);
	if (text === undefined || grepLooksTruncated(text, message.details)) return;
	const paths = parseGrepPaths(text, cwd, args);
	if (paths.size === 0) return;
	for (const path of paths) {
		const epoch = latestEpoch.get(path) ?? 0;
		if (!reads.some((read) => read.path === path && read.epoch === epoch && read.messageIndex > messageIndex)) return;
	}
	maybeStub(stubs, messageIndex, text.length, STUB_SUPERSEDED);
}

function applyForget(
	message: MutableMessage,
	messageIndex: number,
	cwd: string,
	reads: ReadEvidence[],
	greps: Array<{ message: MutableMessage; messageIndex: number; args: Record<string, unknown> }>,
	snapshots: SnapshotEvidence[],
	stubs: Map<number, string>,
): void {
	const directive = forgetDirective(message.details, cwd);
	if (!directive || directive.mode === "superseded_reads") return;
	for (const snapshot of snapshots) {
		if (directive.mode === "paths" && !directive.paths?.has(snapshot.path)) continue;
		maybeStub(stubs, snapshot.messageIndex, snapshot.textLength, STUB_FORGOTTEN);
	}
	for (const read of reads) {
		if (directive.mode === "paths" && !directive.paths?.has(read.path)) continue;
		maybeStub(stubs, read.messageIndex, read.textLength, STUB_FORGOTTEN);
	}
	for (const grep of greps) {
		if (grep.messageIndex > messageIndex) continue;
		const text = textContent(grep.message.content);
		if (text === undefined || grepLooksTruncated(text, grep.message.details)) continue;
		if (directive.mode === "paths") {
			const paths = parseGrepPaths(text, cwd, grep.args);
			if (paths.size === 0 || [...paths].some((path) => !directive.paths?.has(path))) continue;
		}
		maybeStub(stubs, grep.messageIndex, text.length, STUB_FORGOTTEN);
	}
}

function forgetDirective(details: unknown, cwd: string): ForgetDirective | undefined {
	if (!isRecord(details) || !isRecord(details.workingMemory)) return undefined;
	const mode = details.workingMemory.mode;
	if (mode !== "superseded_reads" && mode !== "safe_exploration" && mode !== "paths") return undefined;
	const rawPaths = Array.isArray(details.workingMemory.paths) ? details.workingMemory.paths : [];
	const paths = new Set(
		rawPaths.flatMap((path) => {
			const normalized = normalizePath(cwd, path);
			return normalized ? [normalized] : [];
		}),
	);
	return { mode, paths: paths.size > 0 ? paths : undefined };
}

function patchCovered(patch: PatchResult, snapshots: SnapshotEvidence[], cwd: string): boolean {
	if (patch.changes.length === 0) return false;
	for (const change of patch.changes) {
		const path = normalizePath(cwd, change.path) ?? change.path;
		const snapshot = snapshots.find((candidate) => candidate.path === path);
		if (!snapshot) return false;
		if (change.kind === "delete" && snapshot.state !== "deleted") return false;
		if (change.kind !== "delete" && snapshot.state !== "present") return false;
	}
	return true;
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

function maybeStub(stubs: Map<number, string>, index: number, rawLength: number, stub: string): void {
	if (rawLength - stub.length < SAVINGS_THRESHOLD) return;
	stubs.set(index, stub);
}

function normalizePath(cwd: string, path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const cleaned = path.trim().replace(/^@/, "");
	if (!cleaned) return undefined;
	return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

function optionalPositiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function truncationOutputLines(details: unknown): number | undefined {
	if (!isRecord(details) || !isRecord(details.truncation)) return undefined;
	return optionalPositiveInt(details.truncation.outputLines);
}

function isToolResult(message: AgentMessage): message is MutableMessage & { role: "toolResult" } {
	const record = message as MutableMessage;
	return record.role === "toolResult" && typeof record.toolCallId === "string" && typeof record.toolName === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function textContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return typeof content === "string" ? content : undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
		parts.push(block.text);
	}
	return parts.join("\n");
}

function textContentLength(content: unknown): number | undefined {
	return textContent(content)?.length;
}

function containsRange(outer: Range, inner: Range): boolean {
	return outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

function rangeSize(range: Range): number {
	return range.endLine - range.startLine + 1;
}

function parseRanges(values: unknown[]): Range[] {
	return values.flatMap((value) => {
		if (!isRecord(value)) return [];
		const startLine = optionalPositiveInt(value.startLine);
		const endLine = optionalPositiveInt(value.endLine);
		return startLine && endLine && endLine >= startLine ? [{ startLine, endLine }] : [];
	});
}

function parseGrepPaths(text: string, cwd: string, args: Record<string, unknown>): Set<string> {
	const paths = new Set<string>();
	for (const line of text.split("\n")) {
		if (line.trim() === "" || line.startsWith("[")) continue;
		const match = /^(.+?)(?::\d+(?::|\s)|-\d+-\s)/.exec(line);
		if (!match) return new Set();
		const path = normalizeGrepOutputPath(cwd, args.path, match[1]);
		if (path) paths.add(path);
	}
	return paths;
}

function normalizeGrepOutputPath(cwd: string, rawSearchPath: unknown, rawOutputPath: unknown): string | undefined {
	if (typeof rawOutputPath !== "string") return undefined;
	const outputPath = rawOutputPath.trim();
	if (!outputPath) return undefined;
	if (isAbsolute(outputPath)) return resolve(outputPath);
	const searchPath = normalizePath(cwd, rawSearchPath ?? ".");
	if (!searchPath) return normalizePath(cwd, outputPath);
	if (!outputPath.includes("/") && basename(searchPath) === outputPath) return searchPath;
	return resolve(searchPath, outputPath);
}

function grepLooksTruncated(text: string, details: unknown): boolean {
	if (text.includes("truncated") || text.includes("limit")) return true;
	if (!isRecord(details)) return false;
	return Boolean(details.truncated) || Boolean(details.limitHit) || Boolean(details.hitLimit);
}

function snapshotDetails(
	sourceToolCallId: string,
	path: string,
	state: "present" | "deleted",
	ranges: Range[],
): SnapshotDetails {
	return {
		workingMemory: {
			version: 1,
			type: "mutation-snapshot",
			sourceToolCallId,
			toolName: "patch",
			path,
			state,
			ranges,
		},
	};
}

function contextSnapshotDetails(batchId: string, path: string, ranges: Range[]): SnapshotDetails {
	return {
		workingMemory: {
			version: 1,
			type: "context-snapshot",
			source: "tau-edit",
			batchId,
			path,
			state: "present",
			ranges,
		},
	};
}

function renderSnapshot(path: string, ranges: Range[], lines: string[]): string {
	const blocks = ranges.map((range) => {
		const content = lines.slice(range.startLine - 1, range.endLine).join("\n");
		return `${path}:${range.startLine}-${range.endLine}\n\`\`\`${languageForPath(path)}\n${content}\n\`\`\``;
	});
	return blocks.join("\n\n");
}

function renderContextSnapshot(path: string, content: string, ranges: Range[]): string {
	if (ranges.length === 0) return `${path}\n\`\`\`${languageForPath(path)}\n\`\`\``;
	return `${path}:${ranges[0]!.startLine}-${ranges[0]!.endLine}\n\`\`\`${languageForPath(path)}\n${content}${content.endsWith("\n") ? "" : "\n"}\`\`\``;
}

function expandRanges(rawRanges: Range[] | undefined, lineCount: number): Range[] {
	if (lineCount <= 0) return [];
	const ranges =
		rawRanges && rawRanges.length > 0
			? rawRanges
			: [{ startLine: 1, endLine: Math.min(lineCount, SNAPSHOT_MAX_LINES) }];
	const expanded = mergeLineRanges(
		ranges.map((range) => ({
			startLine: Math.max(1, range.startLine - SNAPSHOT_CONTEXT_LINES),
			endLine: Math.min(lineCount, range.endLine + SNAPSHOT_CONTEXT_LINES),
		})),
	);
	const result: Range[] = [];
	let remaining = SNAPSHOT_MAX_LINES;
	for (const range of expanded) {
		if (remaining <= 0) break;
		const size = Math.min(rangeSize(range), remaining);
		result.push({ startLine: range.startLine, endLine: range.startLine + size - 1 });
		remaining -= size;
	}
	return result;
}

function splitLines(text: string): string[] {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function languageForPath(path: string): string {
	const ext = extname(path).slice(1);
	if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" || ext === "json" || ext === "md") return ext;
	return "";
}
