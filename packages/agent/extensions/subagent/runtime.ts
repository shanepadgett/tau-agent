import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createIsolatedSessionResource, type IsolatedSessionResource } from "../../shared/isolated-session.ts";
import type { AgentDefinition } from "./agents.ts";
import { buildColdResumePrompt, retainSubagentTurn, type RetainedTurnOutcome } from "./resume.ts";
import {
	cloneInvocationSnapshot,
	createSubagentThread,
	disposeSubagentThread,
	extensionPathsForTools,
	FifoGate,
	runSubagentTurn,
	type SubagentDetails,
	type SubagentInvocationSnapshot,
	type SubagentLifecycle,
	type SubagentPhase,
	type SubagentThread,
} from "./run.ts";

const MAX_RETAINED_THREADS = 16;
const GLOBAL_CONCURRENCY = 4;
const SUBAGENT_HOT_WINDOW_MS = 5 * 60 * 1000;

export type SnapshotObserver = (snapshot: SubagentInvocationSnapshot) => void;

export interface SubagentRuntimeOptions {
	now?: () => number;
}

export interface SubagentToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: SubagentDetails;
	usage?: Usage;
}

interface ActiveInvocation {
	snapshot: SubagentInvocationSnapshot;
	controller: AbortController;
	generation: number;
	run: Promise<SubagentToolResult>;
	admitTicket: number;
}

interface TrackedThread extends SubagentThread {
	disposed: boolean;
	disposePromise?: Promise<void>;
}

type ResolveFreshDefinition = () => Promise<
	{ ok: true; definition: AgentDefinition } | { ok: false; error: string; phase: SubagentPhase }
>;

interface ExecuteBag {
	agent: string;
	displayName: string;
	definition: AgentDefinition | undefined;
	thread: TrackedThread | undefined;
	threadId: string | undefined;
	releaseThread: (() => void) | undefined;
	releaseGlobal: (() => void) | undefined;
	reservedThread: TrackedThread | undefined;
	provisionalThread: TrackedThread | undefined;
	provisionalResource: IsolatedSessionResource | undefined;
	reservationToken: symbol | undefined;
	admitAdvanced: boolean;
	phase: SubagentPhase;
	lastPublishedStatus: SubagentLifecycle | undefined;
	combined: AbortSignal;
	task: string;
	continuing: boolean;
	threadKey: string | undefined;
	files: readonly string[] | undefined;
	ctx: ExtensionContext;
	parentModel: string;
	parentThinking: NonNullable<ExtensionContext["thinkingLevel"]>;
	onUpdate: ((details: SubagentDetails) => void | Promise<void>) | undefined;
	resolveFreshDefinition: ResolveFreshDefinition;
	generation: number;
	invocationId: string;
	controller: AbortController;
	startedAt: number;
	active: ActiveInvocation;
	admitTicket: number;
}

function emptyUsage(): SubagentDetails["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function baseDetails(options: {
	agent: string;
	displayName?: string;
	task: string;
	status: SubagentLifecycle;
	phase: SubagentPhase;
	model: string;
	thinkingLevel: string;
	threadId?: string;
	invocationId?: string;
	error?: string;
}): SubagentDetails {
	return {
		agent: options.agent,
		displayName: options.displayName ?? options.agent,
		...(options.threadId === undefined ? {} : { threadId: options.threadId }),
		...(options.invocationId === undefined ? {} : { invocationId: options.invocationId }),
		status: options.status,
		phase: options.phase,
		task: options.task,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		toolCalls: 0,
		actions: [],
		omittedActions: 0,
		omittedErrors: 0,
		usage: emptyUsage(),
		durationMs: 0,
		...(options.error === undefined ? {} : { error: options.error }),
	};
}

export function failedToolResult(
	agent: string,
	task: string,
	phase: SubagentPhase,
	model: string,
	thinkingLevel: string,
	error: string,
	threadId?: string,
	status: "failed" | "aborted" = "failed",
): SubagentToolResult {
	return {
		content: [{ type: "text", text: error }],
		details: baseDetails({ agent, task, status, phase, model, thinkingLevel, threadId, error }),
	};
}

function asTracked(thread: SubagentThread): TrackedThread {
	if ("disposed" in thread) return thread as TrackedThread;
	const tracked = thread as TrackedThread;
	tracked.disposed = false;
	return tracked;
}

/**
 * Session-scoped subagent orchestration.
 * One instance per extension factory lifetime; reset on session_start, dispose on shutdown.
 */
export class SubagentRuntime {
	private generation = 0;
	private nextThreadId = 1;
	private nextInvocationId = 1;
	private nextAdmitTicket = 1;
	private admitHead = 1;
	private readonly admitWaiters = new Map<number, Set<() => void>>();
	private disposed = false;
	/** True while reset/shutdown drains old work. New execute calls abort immediately. */
	private lifecycleFence = false;
	private globalGate = new FifoGate(GLOBAL_CONCURRENCY);
	private readonly threads = new Map<string, TrackedThread>();
	/** Startup reservation tokens. Never bulk-cleared; each invocation releases its own token. */
	private readonly startupReservations = new Set<symbol>();
	private readonly controllers = new Set<AbortController>();
	private readonly invocations = new Map<string, ActiveInvocation>();
	private readonly observers = new Set<SnapshotObserver>();
	private readonly runtimeWarnings = new Set<string>();
	private readonly nameOrdinals = new Map<string, number>();
	private readonly assignedNames = new Set<string>();
	private readonly pi: ExtensionAPI;
	private readonly now: () => number;
	private lifecycleChain = Promise.resolve();

	constructor(pi: ExtensionAPI, options: SubagentRuntimeOptions = {}) {
		this.pi = pi;
		this.now = options.now ?? Date.now;
	}

	subscribe(observer: SnapshotObserver): () => void {
		this.observers.add(observer);
		return () => {
			this.observers.delete(observer);
		};
	}

	listThreads(cwd: string): SubagentThread[] {
		return [...this.threads.values()]
			.filter((thread) => thread.cwd === cwd && !thread.disposed)
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	threadIds(cwd: string): string[] {
		return this.listThreads(cwd).map((thread) => thread.id);
	}

	async reset(): Promise<void> {
		await this.drainLifecycle({ permanent: false });
	}

	async shutdown(): Promise<void> {
		await this.drainLifecycle({ permanent: true });
	}

	private async drainLifecycle(options: { permanent: boolean }): Promise<void> {
		await this.runLifecycle(async () => {
			if (options.permanent) {
				if (this.disposed) return;
				this.disposed = true;
			}
			this.lifecycleFence = true;
			this.generation += 1;
			this.abortAllControllers();
			this.wakeAllAdmitWaiters();
			const running = [...this.invocations.values()].map((item) => item.run.catch(() => undefined));
			await Promise.all(running);
			this.invocations.clear();
			// Replace gate only after old turns have released slots.
			this.globalGate = new FifoGate(GLOBAL_CONCURRENCY);
			if (options.permanent) this.observers.clear();
			else {
				this.nextAdmitTicket = 1;
				this.admitHead = 1;
				this.admitWaiters.clear();
				this.runtimeWarnings.clear();
				this.nameOrdinals.clear();
				this.assignedNames.clear();
			}
			await this.disposeAllThreads();
			if (!options.permanent) this.lifecycleFence = false;
		});
	}

	execute(options: {
		agent: string;
		task: string;
		files?: readonly string[];
		continuing: boolean;
		threadKey?: string;
		definition?: AgentDefinition;
		ctx: ExtensionContext;
		parentModel: string;
		parentThinking: NonNullable<ExtensionContext["thinkingLevel"]>;
		signal?: AbortSignal;
		onUpdate?: (details: SubagentDetails) => void | Promise<void>;
		resolveFreshDefinition: () => Promise<
			{ ok: true; definition: AgentDefinition } | { ok: false; error: string; phase: SubagentPhase }
		>;
	}): Promise<SubagentToolResult> {
		const generation = this.generation;
		const invocationId = `inv-${this.nextInvocationId++}`;
		const admitTicket = this.nextAdmitTicket++;
		const controller = new AbortController();
		this.controllers.add(controller);
		const startedAt = this.now();
		const initialAgent = options.agent;
		const initialSnapshot: SubagentInvocationSnapshot = {
			...baseDetails({
				agent: initialAgent,
				task: options.task,
				status: "waiting",
				phase: "queue",
				model: options.parentModel,
				thinkingLevel: options.parentThinking,
				threadId: options.continuing ? options.threadKey : undefined,
				invocationId,
			}),
			invocationId,
			startedAt,
			files: [...(options.files ?? [])],
		};
		const active: ActiveInvocation = {
			snapshot: initialSnapshot,
			controller,
			generation,
			admitTicket,
			run: Promise.resolve(
				failedToolResult(
					initialAgent,
					options.task,
					"queue",
					options.parentModel,
					options.parentThinking,
					"Subagent invocation failed to start",
					options.threadKey,
				),
			),
		};
		this.invocations.set(invocationId, active);
		this.publish(active.snapshot);

		const run = this.executeInner(options, {
			generation,
			invocationId,
			controller,
			startedAt,
			active,
			admitTicket,
		});
		active.run = run;
		return run;
	}

	private async executeInner(
		options: {
			agent: string;
			task: string;
			files?: readonly string[];
			continuing: boolean;
			threadKey?: string;
			ctx: ExtensionContext;
			parentModel: string;
			parentThinking: NonNullable<ExtensionContext["thinkingLevel"]>;
			definition?: AgentDefinition;
			signal?: AbortSignal;
			onUpdate?: (details: SubagentDetails) => void | Promise<void>;
			resolveFreshDefinition: ResolveFreshDefinition;
		},
		state: {
			generation: number;
			invocationId: string;
			controller: AbortController;
			startedAt: number;
			active: ActiveInvocation;
			admitTicket: number;
		},
	): Promise<SubagentToolResult> {
		const bag = this.createExecuteBag(options, state);
		const fanOut = (details: SubagentDetails, force = false) => this.fanOutInvocation(bag, details, force);
		try {
			return await this.driveExecute(bag, fanOut);
		} catch (error) {
			const handled = await this.handleExecuteError({
				error,
				agent: bag.agent,
				displayName: bag.displayName,
				task: bag.task,
				phase: bag.phase,
				parentModel: bag.parentModel,
				parentThinking: bag.parentThinking,
				thread: bag.thread,
				threadId: bag.threadId,
				invocationId: bag.invocationId,
				combined: bag.combined,
				continuing: bag.continuing,
				provisionalResource: bag.provisionalResource,
				provisionalThread: bag.provisionalThread,
				fanOut,
			});
			bag.provisionalResource = undefined;
			bag.provisionalThread = undefined;
			return handled;
		} finally {
			await this.cleanupExecuteBag(bag);
		}
	}

	private createExecuteBag(
		options: {
			agent: string;
			task: string;
			files?: readonly string[];
			continuing: boolean;
			threadKey?: string;
			ctx: ExtensionContext;
			parentModel: string;
			parentThinking: NonNullable<ExtensionContext["thinkingLevel"]>;
			definition?: AgentDefinition;
			signal?: AbortSignal;
			onUpdate?: (details: SubagentDetails) => void | Promise<void>;
			resolveFreshDefinition: ResolveFreshDefinition;
		},
		state: {
			generation: number;
			invocationId: string;
			controller: AbortController;
			startedAt: number;
			active: ActiveInvocation;
			admitTicket: number;
		},
	): ExecuteBag {
		return {
			agent: options.agent,
			displayName: options.agent,
			definition: options.definition,
			thread: undefined,
			threadId: options.continuing ? options.threadKey : undefined,
			releaseThread: undefined,
			releaseGlobal: undefined,
			reservedThread: undefined,
			provisionalThread: undefined,
			provisionalResource: undefined,
			reservationToken: undefined,
			admitAdvanced: false,
			phase: "queue",
			lastPublishedStatus: "waiting",
			combined: AbortSignal.any([state.controller.signal, ...(options.signal ? [options.signal] : [])]),
			task: options.task,
			continuing: options.continuing,
			threadKey: options.threadKey,
			files: options.files,
			ctx: options.ctx,
			parentModel: options.parentModel,
			parentThinking: options.parentThinking,
			onUpdate: options.onUpdate,
			resolveFreshDefinition: options.resolveFreshDefinition,
			generation: state.generation,
			invocationId: state.invocationId,
			controller: state.controller,
			startedAt: state.startedAt,
			active: state.active,
			admitTicket: state.admitTicket,
		};
	}

	private fanOutInvocation(bag: ExecuteBag, details: SubagentDetails, force = false): void {
		const current = this.invocations.get(bag.invocationId);
		if (!current || current.generation !== this.generation) return;
		if (!force && details.status === bag.lastPublishedStatus && details.status !== "running") return;
		bag.lastPublishedStatus = details.status;
		const next: SubagentInvocationSnapshot = {
			...details,
			invocationId: bag.invocationId,
			startedAt: bag.startedAt,
			files: current.snapshot.files,
			threadId: details.threadId ?? bag.threadId,
			agent: details.agent || bag.agent,
			displayName: details.displayName || bag.displayName,
		};
		current.snapshot = next;
		this.publish(next);
		if (!bag.onUpdate) return;
		// Detached: presentation latency must not block admission or child turns.
		void Promise.resolve()
			.then(() => bag.onUpdate?.(cloneInvocationSnapshot(next)))
			.catch(() => undefined);
	}

	private finishInvocation(bag: ExecuteBag, details: SubagentDetails, text?: string): SubagentToolResult {
		this.fanOutInvocation(bag, details, true);
		return { content: [{ type: "text", text: text ?? details.error ?? details.response ?? "" }], details };
	}

	private failInvocation(
		bag: ExecuteBag,
		error: string,
		failPhase: SubagentPhase,
		overrides: Partial<SubagentDetails> = {},
	): SubagentToolResult {
		return this.finishInvocation(
			bag,
			baseDetails({
				agent: overrides.agent ?? bag.agent,
				displayName: overrides.displayName ?? bag.thread?.displayName ?? bag.displayName,
				task: bag.task,
				status: overrides.status === "aborted" ? "aborted" : "failed",
				phase: failPhase,
				model: overrides.model ?? bag.thread?.model ?? bag.parentModel,
				thinkingLevel: overrides.thinkingLevel ?? bag.thread?.thinkingLevel ?? bag.parentThinking,
				threadId: overrides.threadId ?? bag.thread?.id ?? bag.threadId,
				invocationId: bag.invocationId,
				error,
			}),
			error,
		);
	}

	private abortInvocation(
		bag: ExecuteBag,
		failPhase: SubagentPhase = bag.phase,
		markAdmit = false,
	): SubagentToolResult {
		if (markAdmit && !bag.admitAdvanced) {
			this.advanceAdmitTicket(bag.admitTicket);
			bag.admitAdvanced = true;
		}
		return this.finishInvocation(
			bag,
			this.terminalFromAbort(
				bag.agent,
				bag.displayName,
				bag.task,
				failPhase,
				bag.thread?.model ?? bag.parentModel,
				bag.thread?.thinkingLevel ?? bag.parentThinking,
				bag.threadId,
				bag.invocationId,
			),
		);
	}

	private async driveExecute(
		bag: ExecuteBag,
		fanOut: (details: SubagentDetails, force?: boolean) => void,
	): Promise<SubagentToolResult> {
		if (this.lifecycleFence || this.disposed || bag.generation !== this.generation) {
			return this.abortInvocation(bag);
		}

		const admitted = await this.admitExecuteTarget(bag, fanOut);
		if (admitted) return admitted;

		const gated = await this.gateExecute(bag);
		if (gated) return gated;

		return await this.runExecuteTurn(bag, fanOut);
	}

	private async admitExecuteTarget(
		bag: ExecuteBag,
		fanOut: (details: SubagentDetails, force?: boolean) => void,
	): Promise<SubagentToolResult | undefined> {
		if (bag.continuing) {
			const bound = this.bindContinuingThread({
				threadKey: bag.threadKey ?? "",
				cwd: bag.ctx.cwd,
				parentModel: bag.parentModel,
				parentThinking: bag.parentThinking,
				active: bag.active,
				fanOut,
			});
			if (!bound.ok) return this.failInvocation(bag, bound.error, "discovery", bound.overrides);
			bag.reservedThread = bound.thread;
			bag.thread = bound.thread;
			bag.agent = bound.agent;
			bag.displayName = bound.displayName;
			bag.threadId = bound.threadId;
			bag.definition = bound.definition;
			return undefined;
		}

		bag.phase = "discovery";
		const prepared = await this.prepareFreshDiscovery({
			generation: bag.generation,
			combined: bag.combined,
			active: bag.active,
			resolveFreshDefinition: bag.resolveFreshDefinition,
			fanOut,
		});
		if (prepared.kind === "aborted") return this.abortInvocation(bag);
		if (prepared.kind === "failed") return this.failInvocation(bag, prepared.error, prepared.phase);
		bag.definition = prepared.definition;
		bag.agent = prepared.agent;
		bag.displayName = prepared.displayName;
		bag.threadId = prepared.threadId;
		bag.reservationToken = prepared.reservationToken;
		return undefined;
	}

	private async gateExecute(bag: ExecuteBag): Promise<SubagentToolResult | undefined> {
		const gates = await this.acquireExecutionGates({
			thread: bag.thread,
			admitTicket: bag.admitTicket,
			combined: bag.combined,
			generation: bag.generation,
			phase: bag.phase,
		});
		if (gates.kind === "aborted") {
			bag.admitAdvanced = gates.admitAdvanced;
			return this.abortInvocation(bag, gates.phase, gates.markAdmit);
		}
		if (gates.kind === "failed") {
			bag.admitAdvanced = gates.admitAdvanced;
			return this.failInvocation(bag, gates.error, "queue", gates.overrides);
		}
		bag.releaseThread = gates.releaseThread;
		bag.releaseGlobal = gates.releaseGlobal;
		bag.admitAdvanced = true;
		return undefined;
	}

	private async runExecuteTurn(
		bag: ExecuteBag,
		fanOut: (details: SubagentDetails, force?: boolean) => void,
	): Promise<SubagentToolResult> {
		if (!bag.thread) {
			bag.phase = "startup";
			if (!bag.threadId || !bag.definition) throw new Error("Subagent startup state is incomplete");
			const started = await this.startFreshThread({
				threadId: bag.threadId,
				displayName: bag.displayName,
				definition: bag.definition,
				task: bag.task,
				ctx: bag.ctx,
				parentThinking: bag.parentThinking,
				combined: bag.combined,
				generation: bag.generation,
				agent: bag.agent,
				active: bag.active,
				fanOut,
			});
			if (started.kind === "aborted") {
				bag.thread = started.thread;
				return this.abortInvocation(bag, "startup");
			}
			bag.provisionalThread = started.thread;
			bag.thread = started.thread;
			bag.reservedThread = bag.thread;
		}

		const thread = bag.thread;
		const cold = await this.coldResumeIfNeeded({
			continuing: bag.continuing,
			thread,
			generation: bag.generation,
			combined: bag.combined,
			task: bag.task,
			files: bag.files,
			agent: bag.agent,
			active: bag.active,
			fanOut,
		});
		if (cold.kind === "aborted") {
			bag.provisionalResource = cold.provisionalResource;
			return this.abortInvocation(bag, "startup");
		}
		bag.phase = cold.phase ?? bag.phase;
		bag.provisionalResource = cold.provisionalResource;
		const resumePrompt = cold.resumePrompt;

		const result = await runSubagentTurn({
			thread,
			task: bag.task,
			files: bag.files,
			invocationId: bag.invocationId,
			initial: thread.turns === 0 || resumePrompt !== undefined,
			...(resumePrompt === undefined ? {} : { resumePrompt }),
			signal: bag.combined,
			onUpdate: (details) => {
				fanOut({ ...details, invocationId: bag.invocationId, threadId: bag.thread?.id ?? bag.threadId });
			},
		});

		if (!this.isLive(bag.generation, bag.combined)) {
			const aborted = await this.abortAfterTurn({
				result,
				invocationId: bag.invocationId,
				fanOut,
				reservationToken: bag.reservationToken,
				provisionalThread: bag.provisionalThread,
				thread,
			});
			bag.reservationToken = undefined;
			bag.provisionalThread = undefined;
			return aborted;
		}

		bag.lastPublishedStatus = result.details.status;
		// Drop reservation before publish so capacity never reads above 16.
		this.releaseReservation(bag.reservationToken);
		bag.reservationToken = undefined;
		const finished = await this.retainAndFinishTurn({
			result,
			thread,
			task: bag.task,
			files: bag.files,
			generation: bag.generation,
			continuing: bag.continuing,
			provisionalThread: bag.provisionalThread,
			invocationId: bag.invocationId,
		});
		bag.provisionalThread = undefined;
		return finished;
	}

	private async cleanupExecuteBag(bag: ExecuteBag): Promise<void> {
		if (!bag.admitAdvanced) this.advanceAdmitTicket(bag.admitTicket);
		this.releaseReservation(bag.reservationToken);
		if (bag.provisionalThread && this.threads.get(bag.provisionalThread.id) !== bag.provisionalThread) {
			await this.disposeThread(bag.provisionalThread).catch(() => undefined);
		}
		if (bag.provisionalResource) await bag.provisionalResource.dispose().catch(() => undefined);
		if (bag.reservedThread) bag.reservedThread.pendingTurns = Math.max(0, bag.reservedThread.pendingTurns - 1);
		bag.releaseGlobal?.();
		bag.releaseThread?.();
		this.controllers.delete(bag.controller);
		this.invocations.delete(bag.invocationId);
	}

	private bindContinuingThread(options: {
		threadKey: string;
		cwd: string;
		parentModel: string;
		parentThinking: string;
		active: ActiveInvocation;
		fanOut: (details: SubagentDetails, force?: boolean) => void;
	}):
		| {
				ok: true;
				thread: TrackedThread;
				agent: string;
				displayName: string;
				threadId: string;
				definition: AgentDefinition;
		  }
		| { ok: false; error: string; overrides: Partial<SubagentDetails> } {
		const { threadKey, cwd, parentModel, parentThinking, active, fanOut } = options;
		const existing = this.threads.get(threadKey);
		if (!existing || existing.cwd !== cwd || existing.disposed) {
			const names = this.threadIds(cwd).join(", ") || "none";
			return {
				ok: false,
				error: `Subagent thread ${threadKey} is unavailable. Active threads: ${names}`,
				overrides: {
					agent: threadKey,
					threadId: threadKey,
					model: parentModel,
					thinkingLevel: parentThinking,
				},
			};
		}
		existing.pendingTurns += 1;
		const agent = existing.definition.name;
		const displayName = existing.displayName;
		const threadId = existing.id;
		fanOut(
			{
				...active.snapshot,
				agent,
				displayName,
				threadId,
				model: existing.model,
				thinkingLevel: existing.thinkingLevel,
			},
			true,
		);
		return {
			ok: true,
			thread: existing,
			agent,
			displayName,
			threadId,
			definition: existing.definition,
		};
	}

	private async prepareFreshDiscovery(options: {
		generation: number;
		combined: AbortSignal;
		active: ActiveInvocation;
		resolveFreshDefinition: () => Promise<
			{ ok: true; definition: AgentDefinition } | { ok: false; error: string; phase: SubagentPhase }
		>;
		fanOut: (details: SubagentDetails, force?: boolean) => void;
	}): Promise<
		| {
				kind: "ok";
				definition: AgentDefinition;
				agent: string;
				displayName: string;
				threadId: string;
				reservationToken: symbol;
		  }
		| { kind: "aborted" }
		| { kind: "failed"; error: string; phase: SubagentPhase }
	> {
		const { generation, combined, active, resolveFreshDefinition, fanOut } = options;
		const resolved = await resolveFreshDefinition();
		if (!this.isLive(generation, combined)) return { kind: "aborted" };
		if (!resolved.ok) return { kind: "failed", error: resolved.error, phase: resolved.phase };
		const definition = resolved.definition;
		const agent = definition.name;
		const displayName = this.assignDisplayName(definition);
		const threadId = `thread-${this.nextThreadId++}`;
		fanOut({ ...active.snapshot, agent, displayName, threadId }, true);
		const reserved = this.reserveFreshCapacity();
		if (!reserved.ok) return { kind: "failed", error: reserved.error, phase: "queue" };
		if (reserved.evicted) await this.disposeThread(reserved.evicted);
		return {
			kind: "ok",
			definition,
			agent,
			displayName,
			threadId,
			reservationToken: reserved.token,
		};
	}

	private async acquireExecutionGates(options: {
		thread: TrackedThread | undefined;
		admitTicket: number;
		combined: AbortSignal;
		generation: number;
		phase: SubagentPhase;
	}): Promise<
		| {
				kind: "ok";
				releaseThread: (() => void) | undefined;
				releaseGlobal: () => void;
		  }
		| { kind: "aborted"; phase: SubagentPhase; markAdmit: boolean; admitAdvanced: boolean }
		| {
				kind: "failed";
				error: string;
				admitAdvanced: boolean;
				overrides: Partial<SubagentDetails>;
		  }
	> {
		const { thread, admitTicket, combined, generation, phase } = options;
		// FIFO barrier assigned at execute() entry — earlier tickets go first regardless of discovery speed.
		const admitted = await this.waitAdmitTicket(admitTicket, combined, generation);
		if (!admitted) return { kind: "aborted", phase, markAdmit: true, admitAdvanced: false };

		let releaseThread: (() => void) | undefined;
		if (thread) {
			releaseThread = await thread.turnGate.acquire(combined);
			if (thread.disposed || this.threads.get(thread.id) !== thread) {
				this.advanceAdmitTicket(admitTicket);
				releaseThread();
				return {
					kind: "failed",
					error: `Subagent thread ${thread.id} is unavailable after queueing`,
					admitAdvanced: true,
					overrides: {
						status: combined.aborted ? "aborted" : "failed",
						model: thread.model,
						thinkingLevel: thread.thinkingLevel,
						threadId: thread.id,
					},
				};
			}
		}
		if (!this.isLive(generation, combined)) {
			releaseThread?.();
			return { kind: "aborted", phase, markAdmit: true, admitAdvanced: false };
		}

		let releaseGlobal: () => void;
		try {
			releaseGlobal = await this.globalGate.acquire(combined);
		} catch {
			releaseThread?.();
			return { kind: "aborted", phase, markAdmit: true, admitAdvanced: false };
		}
		// Next ticket may compete for remaining global slots.
		this.advanceAdmitTicket(admitTicket);
		if (!this.isLive(generation, combined)) {
			// Caller keeps releaseThread/releaseGlobal unset; free them here before abort return.
			releaseGlobal();
			releaseThread?.();
			return { kind: "aborted", phase, markAdmit: false, admitAdvanced: true };
		}
		return { kind: "ok", releaseThread, releaseGlobal };
	}

	private async startFreshThread(options: {
		threadId: string;
		displayName: string;
		definition: AgentDefinition;
		task: string;
		ctx: ExtensionContext;
		parentThinking: NonNullable<ExtensionContext["thinkingLevel"]>;
		combined: AbortSignal;
		generation: number;
		agent: string;
		active: ActiveInvocation;
		fanOut: (details: SubagentDetails, force?: boolean) => void;
	}): Promise<{ kind: "ok"; thread: TrackedThread } | { kind: "aborted"; thread: TrackedThread }> {
		const {
			threadId,
			displayName,
			definition,
			task,
			ctx,
			parentThinking,
			combined,
			generation,
			agent,
			active,
			fanOut,
		} = options;
		fanOut({ ...active.snapshot, status: "starting", phase: "startup", agent, threadId }, true);
		const created = asTracked(
			await createSubagentThread({
				id: threadId,
				displayName,
				definition,
				extensionPaths: extensionPathsForTools(this.pi, definition.tools),
				initialTask: task,
				ctx,
				thinkingLevel: parentThinking,
				signal: combined,
				onWarning: (warning) => {
					const message = `Subagent definition ${definition.path}: ${warning}`;
					if (this.runtimeWarnings.has(message)) return;
					this.runtimeWarnings.add(message);
					ctx.ui.notify(message, "warning");
				},
			}),
		);
		if (!this.isLive(generation, combined)) {
			await this.disposeThread(created);
			return { kind: "aborted", thread: created };
		}
		created.pendingTurns += 1;
		return { kind: "ok", thread: created };
	}

	private async coldResumeIfNeeded(options: {
		continuing: boolean;
		thread: TrackedThread;
		generation: number;
		combined: AbortSignal;
		task: string;
		files: readonly string[] | undefined;
		agent: string;
		active: ActiveInvocation;
		fanOut: (details: SubagentDetails, force?: boolean) => void;
	}): Promise<
		| { kind: "ok"; resumePrompt?: string; phase?: SubagentPhase; provisionalResource?: IsolatedSessionResource }
		| { kind: "aborted"; provisionalResource?: IsolatedSessionResource }
	> {
		const { continuing, thread, generation, combined, task, files, agent, active, fanOut } = options;
		const needsCold =
			continuing &&
			(thread.lastAssistantMessageAt === undefined ||
				this.now() - thread.lastAssistantMessageAt >= SUBAGENT_HOT_WINDOW_MS);
		if (!needsCold) return { kind: "ok" };

		fanOut({ ...active.snapshot, status: "starting", phase: "startup", agent, threadId: thread.id }, true);
		const oldResource = thread.resource;
		const provisionalResource = await createIsolatedSessionResource(thread.sessionInputs, combined);
		if (!this.isLive(generation, combined) || thread.disposed || this.threads.get(thread.id) !== thread) {
			await provisionalResource.dispose();
			if (this.threads.get(thread.id) === thread) this.threads.delete(thread.id);
			await this.disposeThread(thread);
			return { kind: "aborted" };
		}
		thread.resource = provisionalResource;
		await oldResource.dispose();
		if (!this.isLive(generation, combined)) {
			if (this.threads.get(thread.id) === thread) this.threads.delete(thread.id);
			await this.disposeThread(thread);
			return { kind: "aborted" };
		}
		return {
			kind: "ok",
			phase: "startup",
			resumePrompt: buildColdResumePrompt({
				definition: thread.definition,
				state: thread.resumeState,
				followUp: task,
				hasAutoreadFiles: (files?.length ?? 0) > 0,
			}),
		};
	}

	private async abortAfterTurn(options: {
		result: {
			details: SubagentDetails;
			usage?: Usage;
		};
		invocationId: string;
		fanOut: (details: SubagentDetails, force?: boolean) => void;
		reservationToken: symbol | undefined;
		provisionalThread: TrackedThread | undefined;
		thread: TrackedThread;
	}): Promise<SubagentToolResult> {
		const { result, invocationId, fanOut, reservationToken, provisionalThread, thread } = options;
		const details = {
			...result.details,
			status: "aborted" as const,
			invocationId,
			error: result.details.error ?? "Subagent session reset",
		};
		fanOut(details, true);
		this.releaseReservation(reservationToken);
		if (provisionalThread) await this.disposeThread(provisionalThread);
		else if (this.threads.get(thread.id) === thread) {
			this.threads.delete(thread.id);
			await this.disposeThread(thread);
		}
		return {
			content: [{ type: "text", text: details.error ?? "aborted" }],
			details,
			...(result.usage === undefined ? {} : { usage: result.usage }),
		};
	}

	private toolResultFromTurn(
		result: {
			content: string;
			details: SubagentDetails;
			usage?: Usage;
		},
		thread: TrackedThread,
		invocationId: string,
		retained: boolean,
	): SubagentToolResult {
		const details = {
			...result.details,
			displayName: thread.displayName,
			invocationId,
			threadId: thread.id,
		};
		const text = retained
			? `Thread: ${thread.id}\nReuse with subagent({ thread: "${thread.id}", task: "..." })\n\n${result.content}`
			: result.content;
		return {
			content: [{ type: "text", text }],
			details,
			...(result.usage === undefined ? {} : { usage: result.usage }),
		};
	}

	private async retainAndFinishTurn(options: {
		result: {
			content: string;
			details: SubagentDetails;
			retainable: boolean;
			terminalOutcome: RetainedTurnOutcome;
			assistantMessageEndAt: readonly number[];
			usage?: Usage;
		};
		thread: TrackedThread;
		task: string;
		files: readonly string[] | undefined;
		generation: number;
		continuing: boolean;
		provisionalThread: TrackedThread | undefined;
		invocationId: string;
	}): Promise<SubagentToolResult> {
		const { result, thread, task, files, generation, continuing, provisionalThread, invocationId } = options;
		if (result.retainable) {
			thread.resumeState = retainSubagentTurn(thread.resumeState, {
				task,
				outcome: result.terminalOutcome,
				terminalText: result.content,
				files: files ?? [],
			});
			thread.lastAssistantMessageAt = result.assistantMessageEndAt.at(-1);
		}
		const retained = await this.finalizeThreadRetention({
			generation,
			continuing,
			thread,
			provisional: provisionalThread === thread,
			result,
		});
		return this.toolResultFromTurn(result, thread, invocationId, retained);
	}

	private async handleExecuteError(options: {
		error: unknown;
		agent: string;
		displayName: string;
		task: string;
		phase: SubagentPhase;
		parentModel: string;
		parentThinking: string;
		thread: TrackedThread | undefined;
		threadId: string | undefined;
		invocationId: string;
		combined: AbortSignal;
		continuing: boolean;
		provisionalResource: IsolatedSessionResource | undefined;
		provisionalThread: TrackedThread | undefined;
		fanOut: (details: SubagentDetails, force?: boolean) => void;
	}): Promise<SubagentToolResult> {
		const {
			error,
			agent,
			displayName,
			task,
			phase,
			parentModel,
			parentThinking,
			thread,
			threadId,
			invocationId,
			combined,
			continuing,
			provisionalResource,
			provisionalThread,
			fanOut,
		} = options;
		const message = error instanceof Error ? error.message : `Agent ${agent} ${phase} failed`;
		const status: SubagentLifecycle = combined.aborted ? "aborted" : "failed";
		const details = baseDetails({
			agent,
			task,
			status,
			phase,
			model: thread?.model ?? parentModel,
			thinkingLevel: thread?.thinkingLevel ?? parentThinking,
			displayName: thread?.displayName ?? displayName,
			threadId: thread?.id ?? threadId,
			invocationId,
			error: message,
		});
		fanOut(details, true);
		if (provisionalResource) await provisionalResource.dispose().catch(() => undefined);
		if (provisionalThread) await this.disposeThread(provisionalThread);
		else if (thread && continuing && this.threads.get(thread.id) === thread) {
			this.threads.delete(thread.id);
			await this.disposeThread(thread);
		}
		return { content: [{ type: "text", text: message }], details };
	}

	private async waitAdmitTicket(ticket: number, signal: AbortSignal, generation: number): Promise<boolean> {
		if (signal.aborted || generation !== this.generation || this.disposed || this.lifecycleFence) {
			return false;
		}
		if (this.admitHead === ticket) return true;
		return new Promise<boolean>((resolve) => {
			const wake = () => {
				if (signal.aborted || generation !== this.generation || this.disposed || this.lifecycleFence) {
					cleanup();
					resolve(false);
					return;
				}
				if (this.admitHead === ticket) {
					cleanup();
					resolve(true);
				}
			};
			const onAbort = () => wake();
			const cleanup = () => {
				signal.removeEventListener("abort", onAbort);
				const waiters = this.admitWaiters.get(ticket);
				if (!waiters) return;
				waiters.delete(wake);
				if (waiters.size === 0) this.admitWaiters.delete(ticket);
			};
			const waiters = this.admitWaiters.get(ticket) ?? new Set<() => void>();
			waiters.add(wake);
			this.admitWaiters.set(ticket, waiters);
			signal.addEventListener("abort", onAbort, { once: true });
			wake();
		});
	}

	private advanceAdmitTicket(ticket: number): void {
		if (ticket !== this.admitHead) {
			// Out-of-order completion: still must not stall the head forever.
			// Mark by bumping only when head matches; otherwise queue skip via recursive advance when head reaches us.
			// Store skipped tickets.
			this.skippedAdmitTickets.add(ticket);
			this.drainAdmitSkips();
			return;
		}
		this.admitHead += 1;
		this.drainAdmitSkips();
		const waiters = this.admitWaiters.get(this.admitHead);
		if (waiters) for (const wake of waiters) wake();
	}

	private readonly skippedAdmitTickets = new Set<number>();

	private drainAdmitSkips(): void {
		while (this.skippedAdmitTickets.has(this.admitHead)) {
			this.skippedAdmitTickets.delete(this.admitHead);
			this.admitHead += 1;
			const waiters = this.admitWaiters.get(this.admitHead);
			if (waiters) for (const wake of waiters) wake();
		}
	}

	private wakeAllAdmitWaiters(): void {
		for (const waiters of this.admitWaiters.values()) for (const wake of waiters) wake();
		this.admitWaiters.clear();
	}

	private async finalizeThreadRetention(options: {
		generation: number;
		continuing: boolean;
		thread: TrackedThread;
		provisional: boolean;
		result: { details: SubagentDetails; retainable: boolean };
	}): Promise<boolean> {
		const { generation, continuing, thread, provisional, result } = options;
		if (generation !== this.generation || this.disposed) {
			if (this.threads.get(thread.id) === thread) this.threads.delete(thread.id);
			await this.disposeThread(thread);
			return false;
		}
		if (provisional) {
			if (result.details.status === "completed" && result.retainable) {
				this.threads.set(thread.id, thread);
				return true;
			}
			await this.disposeThread(thread);
			return false;
		}
		if (!continuing) return this.threads.has(thread.id);
		if (result.retainable && !thread.disposed) return true;
		if (this.threads.get(thread.id) === thread) this.threads.delete(thread.id);
		await this.disposeThread(thread);
		return false;
	}

	private reserveFreshCapacity(): { ok: true; token: symbol; evicted?: TrackedThread } | { ok: false; error: string } {
		if (this.threads.size + this.startupReservations.size < MAX_RETAINED_THREADS) {
			const token = Symbol("startup-reservation");
			this.startupReservations.add(token);
			return { ok: true, token };
		}
		const evicted = [...this.threads.values()]
			.filter((item) => item.pendingTurns === 0 && !item.disposed)
			.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
		if (!evicted) {
			return {
				ok: false,
				error: "Subagent thread limit reached while all retained threads are busy",
			};
		}
		this.threads.delete(evicted.id);
		const token = Symbol("startup-reservation");
		this.startupReservations.add(token);
		return { ok: true, token, evicted };
	}

	private assignDisplayName(definition: AgentDefinition): string {
		const ordinal = this.nameOrdinals.get(definition.name) ?? 0;
		this.nameOrdinals.set(definition.name, ordinal + 1);
		const base = definition.names[ordinal % definition.names.length] ?? definition.name;
		let cycle = Math.floor(ordinal / definition.names.length) + 1;
		let candidate = cycle === 1 ? base : `${base}-${cycle}`;
		while (this.assignedNames.has(candidate)) {
			cycle += 1;
			candidate = `${base}-${cycle}`;
		}
		this.assignedNames.add(candidate);
		return candidate;
	}

	private releaseReservation(token: symbol | undefined): void {
		if (!token) return;
		this.startupReservations.delete(token);
	}

	private isLive(generation: number, signal: AbortSignal): boolean {
		return !this.disposed && !this.lifecycleFence && generation === this.generation && !signal.aborted;
	}

	private terminalFromAbort(
		agent: string,
		displayName: string,
		task: string,
		phase: SubagentPhase,
		model: string,
		thinkingLevel: string,
		threadId: string | undefined,
		invocationId: string,
	): SubagentDetails {
		return baseDetails({
			agent,
			displayName,
			task,
			status: "aborted",
			phase,
			model,
			thinkingLevel,
			threadId,
			invocationId,
			error: "Subagent call aborted",
		});
	}

	private publish(snapshot: SubagentInvocationSnapshot): void {
		const immutable = cloneInvocationSnapshot(snapshot);
		for (const observer of this.observers) {
			try {
				observer(cloneInvocationSnapshot(immutable));
			} catch {
				// Observers must not break the runtime.
			}
		}
	}

	private abortAllControllers(): void {
		for (const controller of this.controllers) controller.abort();
		this.controllers.clear();
	}

	private async disposeThread(thread: TrackedThread): Promise<void> {
		if (thread.disposePromise) return thread.disposePromise;
		thread.disposed = true;
		thread.disposePromise = disposeSubagentThread(thread).catch(() => undefined);
		return thread.disposePromise;
	}

	private async disposeAllThreads(): Promise<void> {
		const retained = [...this.threads.values()];
		this.threads.clear();
		await Promise.all(retained.map((thread) => this.disposeThread(thread)));
	}

	private runLifecycle(work: () => Promise<void>): Promise<void> {
		const next = this.lifecycleChain.then(work, work);
		this.lifecycleChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}
