import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DefaultResourceLoader,
	formatSize,
	getAgentDir,
	SessionManager,
	truncateHead,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.ts";

const PREVIEW_LIMIT = 600;
const VALUE_LIMIT = 180;

const CHILD_UI_BLOCKED_METHODS = new Set([
	"setEditorComponent",
	"setFooter",
	"setStatus",
	"setTitle",
	"setWidget",
	"setWorkingIndicator",
]);

function childUiContext(ui: ExtensionContext["ui"]): ExtensionContext["ui"] {
	return new Proxy(ui, {
		get(target, property, receiver) {
			if (typeof property === "string" && CHILD_UI_BLOCKED_METHODS.has(property)) return () => undefined;
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export interface SubagentAction {
	tool: string;
	summary: string;
	error: boolean;
}
export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export type SubagentLifecycle = "waiting" | "starting" | "running" | "completed" | "failed" | "aborted";
export type SubagentPhase = "discovery" | "queue" | "startup" | "run" | "output";

export interface SubagentDetails {
	agent: string;
	threadId?: string;
	invocationId?: string;
	status: SubagentLifecycle;
	phase: SubagentPhase;
	completionState?: string;
	task: string;
	model: string;
	thinkingLevel: string;
	response?: string;
	error?: string;
	currentActivity?: string;
	toolCalls: number;
	actions: SubagentAction[];
	omittedActions: number;
	omittedErrors: number;
	usage: SubagentUsage;
	durationMs: number;
	truncation?: {
		truncated: boolean;
		path?: string;
		outputLines: number;
		totalLines: number;
		outputBytes: number;
		totalBytes: number;
	};
}

/** Immutable observer payload. Distinct invocation IDs for queued turns of one thread. */
export interface SubagentInvocationSnapshot extends SubagentDetails {
	invocationId: string;
	startedAt: number;
}

export interface SubagentThread {
	id: string;
	definition: AgentDefinition;
	session: AgentSession;
	cwd: string;
	model: string;
	thinkingLevel: string;
	initialTask: string;
	turns: number;
	turnGate: FifoGate;
	pendingTurns: number;
	lastUsedAt: number;
}

export function extensionPathsForTools(pi: ExtensionAPI, tools: readonly string[]): string[] {
	const selected = new Set(tools);
	return [
		...new Set(
			pi
				.getAllTools()
				.filter((tool) => selected.has(tool.name))
				.map((tool) => tool.sourceInfo.path)
				.filter((path) => path.length > 0 && !path.startsWith("<")),
		),
	].sort();
}

export class FifoGate {
	private active = 0;
	private readonly waiters: Array<{
		signal: AbortSignal;
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
	}> = [];
	private readonly limit: number;
	constructor(limit = 4) {
		this.limit = limit;
	}
	acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) return Promise.reject(new Error("Subagent call aborted while waiting"));
		if (this.active < this.limit) {
			this.active += 1;
			return Promise.resolve(this.releaseOnce());
		}
		return new Promise((resolve, reject) => {
			const waiter = { signal, resolve: (_release: () => void) => {}, reject };
			const abort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(new Error("Subagent call aborted while waiting"));
			};
			signal.addEventListener("abort", abort, { once: true });
			waiter.resolve = (release) => {
				signal.removeEventListener("abort", abort);
				resolve(release);
			};
			this.waiters.push(waiter);
		});
	}
	private releaseOnce(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) next.resolve(this.releaseOnce());
			else this.active -= 1;
		};
	}
}

function capped(value: unknown, limit = VALUE_LIMIT): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		text = "[unavailable]";
	}
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Rolling tail so live previews keep changing after the limit. */
export function cappedTail(value: unknown, limit = PREVIEW_LIMIT): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		text = "[unavailable]";
	}
	if (text.length <= limit) return text;
	return `…${text.slice(-(limit - 1))}`;
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function cloneSnapshot(details: SubagentDetails): SubagentDetails {
	return structuredClone(details);
}

export function cloneInvocationSnapshot(snapshot: SubagentInvocationSnapshot): SubagentInvocationSnapshot {
	return structuredClone(snapshot);
}

export async function createSubagentThread(options: {
	id: string;
	definition: AgentDefinition;
	extensionPaths: readonly string[];
	initialTask: string;
	ctx: ExtensionContext;
	thinkingLevel: string;
	signal: AbortSignal;
	onWarning?: (warning: string) => void;
}): Promise<SubagentThread> {
	const {
		id,
		definition,
		extensionPaths,
		initialTask,
		ctx,
		thinkingLevel: parentThinkingLevel,
		signal,
		onWarning,
	} = options;
	let model = ctx.model;
	let thinkingLevel = parentThinkingLevel;
	if (definition.model) {
		const separator = definition.model.indexOf("/");
		const configured = ctx.modelRegistry.find(
			definition.model.slice(0, separator),
			definition.model.slice(separator + 1),
		);
		if (!configured) onWarning?.(`model ${definition.model} is unavailable; using parent model`);
		else {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configured);
			if (!auth.ok) onWarning?.(`model ${definition.model} is unavailable: ${auth.error}; using parent model`);
			else model = configured;
		}
	}
	if (definition.thinking) {
		const mapped = model?.thinkingLevelMap?.[definition.thinking];
		const unsupported =
			!model?.reasoning ||
			mapped === null ||
			((definition.thinking === "xhigh" || definition.thinking === "max") && mapped === undefined);
		if (unsupported)
			onWarning?.(`thinking ${definition.thinking} is unavailable for the selected model; using parent thinking`);
		else thinkingLevel = definition.thinking;
	}
	const modelName = model ? `${model.provider}/${model.id}` : "unavailable";
	let session: AgentSession | undefined;
	try {
		if (!model) throw new Error(`Agent ${definition.name} startup failed: parent has no model`);
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(`Agent ${definition.name} startup failed: ${auth.error}`);
		if (signal.aborted) throw new Error(`Agent ${definition.name} startup aborted`);
		const resourceLoader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			additionalExtensionPaths: [...extensionPaths],
		});
		await resourceLoader.reload();
		if (signal.aborted) throw new Error(`Agent ${definition.name} startup aborted`);
		const created = await createAgentSession({
			cwd: ctx.cwd,
			model,
			thinkingLevel: thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
			tools: definition.tools,
			excludeTools: ["subagent"],
			resourceLoader,
			sessionManager: SessionManager.inMemory(ctx.cwd),
		});
		session = created.session;
		if (signal.aborted) throw new Error(`Agent ${definition.name} startup aborted`);
		await session.bindExtensions(
			ctx.mode === "tui" && ctx.hasUI ? { mode: "tui", uiContext: childUiContext(ctx.ui) } : { mode: "print" },
		);
		if (signal.aborted) throw new Error(`Agent ${definition.name} startup aborted`);
		const active = session.getActiveToolNames().sort();
		const expected = [...definition.tools].sort();
		if (active.join("\0") !== expected.join("\0") || active.includes("subagent")) {
			const missing = expected.filter((tool) => !active.includes(tool));
			throw new Error(
				`Agent ${definition.name} startup failed: unavailable tools: ${missing.join(", ") || "active tool mismatch"}`,
			);
		}
		return {
			id,
			definition,
			session,
			cwd: ctx.cwd,
			model: modelName,
			thinkingLevel,
			initialTask,
			turns: 0,
			turnGate: new FifoGate(1),
			pendingTurns: 0,
			lastUsedAt: Date.now(),
		};
	} catch (error) {
		if (session?.isStreaming) await session.abort().catch(() => undefined);
		session?.dispose();
		throw error;
	}
}

export async function disposeSubagentThread(thread: SubagentThread): Promise<void> {
	if (thread.session.isStreaming) await thread.session.abort().catch(() => undefined);
	thread.session.dispose();
}

export async function runSubagentTurn(options: {
	thread: SubagentThread;
	task: string;
	initial: boolean;
	signal: AbortSignal;
	onUpdate?: (details: SubagentDetails) => void | Promise<void>;
}): Promise<{ content: string; details: SubagentDetails; retainable: boolean }> {
	const { thread, task, initial, signal, onUpdate } = options;
	const { definition, session } = thread;
	const started = Date.now();
	const usage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const details: SubagentDetails = {
		agent: definition.name,
		threadId: thread.id,
		status: "running",
		phase: "run",
		task,
		model: thread.model,
		thinkingLevel: thread.thinkingLevel,
		toolCalls: 0,
		actions: [],
		omittedActions: 0,
		omittedErrors: 0,
		usage,
		durationMs: 0,
	};
	let unsubscribe: (() => void) | undefined;
	let lastTextUpdate = 0;
	const turnMessages: AssistantMessage[] = [];
	let retainable = false;
	const publish = (force = false) => {
		const now = Date.now();
		if (!force && now - lastTextUpdate < 100) return;
		lastTextUpdate = now;
		details.durationMs = now - started;
		const snapshot = cloneSnapshot(details);
		snapshot.actions = snapshot.actions.slice(-5);
		// Detached observer chain — must not delay prompt completion.
		void Promise.resolve()
			.then(() => onUpdate?.(snapshot))
			.catch(() => undefined);
	};
	try {
		if (signal.aborted) {
			details.status = "aborted";
			details.error = "Subagent call aborted before prompt";
			details.durationMs = Date.now() - started;
			publish(true);
			return { content: details.error, details, retainable: false };
		}
		const actionById = new Map<string, string>();
		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_update" && event.message.role === "assistant") {
				details.response = cappedTail(textOf(event.message), PREVIEW_LIMIT);
				publish();
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				turnMessages.push(event.message);
				details.response = cappedTail(textOf(event.message), PREVIEW_LIMIT);
				details.currentActivity = undefined;
				publish(true);
			} else if (event.type === "tool_execution_start") {
				details.toolCalls += 1;
				const summary = `${event.toolName} ${capped(event.args)}`.trim();
				actionById.set(event.toolCallId, summary);
				details.currentActivity = summary;
				publish(true);
			} else if (event.type === "tool_execution_end") {
				const action = {
					tool: event.toolName,
					summary: actionById.get(event.toolCallId) ?? event.toolName,
					error: event.isError,
				};
				details.actions.push(action);
				if (details.actions.length > 20) {
					const removable = details.actions.findIndex((item) => !item.error);
					const [removed] = details.actions.splice(removable >= 0 ? removable : 0, 1);
					details.omittedActions += 1;
					if (removed?.error) details.omittedErrors += 1;
				}
				details.currentActivity = undefined;
				publish(true);
			}
		});
		const abort = () => {
			void session.abort().catch(() => undefined);
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			await session.prompt(
				initial
					? `You are an isolated delegated child agent. Stay within the delegated task and return only the requested result.\n\n## Agent instructions\n${definition.prompt}\n\n## Delegated task\n${task}`
					: `Continue the existing delegated work using the context already in this thread. Return only the requested result.\n\n## Parent follow-up\n${task}`,
				{ expandPromptTemplates: false },
			);
		} finally {
			signal.removeEventListener("abort", abort);
		}
		// Prompt returned without throw — session remains usable for retention decisions.
		retainable = true;
		for (const message of turnMessages) {
			usage.input += message.usage.input;
			usage.output += message.usage.output;
			usage.cacheRead += message.usage.cacheRead;
			usage.cacheWrite += message.usage.cacheWrite;
			usage.cost += message.usage.cost.total;
			usage.turns += 1;
		}
		const terminal = turnMessages.at(-1);
		if (!terminal) throw new Error(`Agent ${definition.name} run failed: no terminal assistant response`);
		const response = textOf(terminal);
		if (terminal.stopReason === "aborted") {
			details.status = "aborted";
			details.completionState = "aborted";
			details.error = capped(terminal.errorMessage ?? "Child aborted");
		} else if (terminal.stopReason === "error") {
			details.status = "failed";
			details.completionState = "error";
			details.error = capped(terminal.errorMessage ?? "Child terminal error");
		} else if ((terminal.stopReason === "stop" || terminal.stopReason === "length") && response.trim()) {
			details.status = "completed";
			details.completionState = terminal.stopReason;
			details.phase = "output";
			const truncation = truncateHead(response, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			let returned = truncation.content;
			let path: string | undefined;
			if (truncation.truncated) {
				const directory = await mkdtemp(join(tmpdir(), "tau-subagent-"));
				path = join(directory, "output.md");
				await writeFile(path, response, { encoding: "utf8", mode: 0o600 });
				returned += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${path}]`;
			}
			details.response = returned;
			details.truncation = {
				truncated: truncation.truncated,
				path,
				outputLines: truncation.outputLines,
				totalLines: truncation.totalLines,
				outputBytes: truncation.outputBytes,
				totalBytes: truncation.totalBytes,
			};
		} else {
			details.status = "failed";
			details.completionState = terminal.stopReason;
			details.error = `Agent ${definition.name} run failed: empty or non-terminal response`;
		}
		details.durationMs = Date.now() - started;
		publish(true);
		return {
			content:
				details.status === "completed"
					? (details.response ?? "")
					: (details.error ?? `Agent ${definition.name} failed`),
			details,
			retainable,
		};
	} catch (error) {
		details.status = signal.aborted ? "aborted" : "failed";
		details.error = capped(error instanceof Error ? error.message : "Subagent failed");
		details.durationMs = Date.now() - started;
		// Prompt/session failures leave the child unsafe for reuse.
		retainable = false;
		publish(true);
		return { content: details.error, details, retainable };
	} finally {
		unsubscribe?.();
		thread.turns += 1;
		thread.lastUsedAt = Date.now();
		if (session.isStreaming) await session.abort().catch(() => undefined);
	}
}
