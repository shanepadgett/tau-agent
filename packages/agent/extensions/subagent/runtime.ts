import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.ts";
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

export type SnapshotObserver = (snapshot: SubagentInvocationSnapshot) => void;

export interface SubagentToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: SubagentDetails;
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
	private lifecycleChain = Promise.resolve();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
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

	/** Exposed for tests. */
	get retainedCount(): number {
		return this.threads.size;
	}

	/** Exposed for tests. */
	get capacityInUse(): number {
		return this.threads.size + this.startupReservations.size;
	}

	/** Exposed for tests. */
	get currentGeneration(): number {
		return this.generation;
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
		continuing: boolean;
		threadKey?: string;
		definition?: AgentDefinition;
		ctx: ExtensionContext;
		parentModel: string;
		parentThinking: string;
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
		const startedAt = Date.now();
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
			continuing: boolean;
			threadKey?: string;
			ctx: ExtensionContext;
			parentModel: string;
			parentThinking: string;
			definition?: AgentDefinition;
			signal?: AbortSignal;
			onUpdate?: (details: SubagentDetails) => void | Promise<void>;
			resolveFreshDefinition: () => Promise<
				{ ok: true; definition: AgentDefinition } | { ok: false; error: string; phase: SubagentPhase }
			>;
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
		const { task, continuing, ctx, parentModel, parentThinking, signal, onUpdate, resolveFreshDefinition } = options;
		const { generation, invocationId, controller, startedAt, active, admitTicket } = state;
		let agent = options.agent;
		let displayName = options.agent;
		let definition = options.definition;
		let thread: TrackedThread | undefined;
		let threadId = continuing ? options.threadKey : undefined;
		const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);

		let releaseThread: (() => void) | undefined;
		let releaseGlobal: (() => void) | undefined;
		let reservedThread: TrackedThread | undefined;
		let provisionalThread: TrackedThread | undefined;
		let reservationToken: symbol | undefined;
		let admitAdvanced = false;
		let phase: SubagentPhase = "queue";
		let lastPublishedStatus: SubagentLifecycle | undefined = "waiting";

		const fanOut = (details: SubagentDetails, force = false) => {
			const current = this.invocations.get(invocationId);
			if (!current || current.generation !== this.generation) return;
			if (!force && details.status === lastPublishedStatus && details.status !== "running") return;
			lastPublishedStatus = details.status;
			const next: SubagentInvocationSnapshot = {
				...details,
				invocationId,
				startedAt,
				threadId: details.threadId ?? threadId,
				agent: details.agent || agent,
				displayName: details.displayName || displayName,
			};
			current.snapshot = next;
			this.publish(next);
			if (!onUpdate) return;
			// Detached: presentation latency must not block admission or child turns.
			void Promise.resolve()
				.then(() => onUpdate(cloneInvocationSnapshot(next)))
				.catch(() => undefined);
		};

		const finish = (details: SubagentDetails, text?: string): SubagentToolResult => {
			fanOut(details, true);
			return { content: [{ type: "text", text: text ?? details.error ?? details.response ?? "" }], details };
		};

		const fail = (
			error: string,
			failPhase: SubagentPhase,
			overrides: Partial<SubagentDetails> = {},
		): SubagentToolResult =>
			finish(
				baseDetails({
					agent: overrides.agent ?? agent,
					displayName: overrides.displayName ?? thread?.displayName ?? displayName,
					task,
					status: overrides.status === "aborted" ? "aborted" : "failed",
					phase: failPhase,
					model: overrides.model ?? thread?.model ?? parentModel,
					thinkingLevel: overrides.thinkingLevel ?? thread?.thinkingLevel ?? parentThinking,
					threadId: overrides.threadId ?? thread?.id ?? threadId,
					invocationId,
					error,
				}),
				error,
			);

		const abortNow = (failPhase: SubagentPhase = phase, markAdmit = false): SubagentToolResult => {
			if (markAdmit && !admitAdvanced) {
				this.advanceAdmitTicket(admitTicket);
				admitAdvanced = true;
			}
			return finish(
				this.terminalFromAbort(
					agent,
					displayName,
					task,
					failPhase,
					thread?.model ?? parentModel,
					thread?.thinkingLevel ?? parentThinking,
					threadId,
					invocationId,
				),
			);
		};

		try {
			if (this.lifecycleFence || this.disposed || generation !== this.generation) return abortNow();

			if (continuing) {
				const key = options.threadKey ?? "";
				const existing = this.threads.get(key);
				if (!existing || existing.cwd !== ctx.cwd || existing.disposed) {
					const names = this.threadIds(ctx.cwd).join(", ") || "none";
					return fail(`Subagent thread ${key} is unavailable. Active threads: ${names}`, "discovery", {
						agent: key,
						threadId: key,
						model: parentModel,
						thinkingLevel: parentThinking,
					});
				}
				existing.pendingTurns += 1;
				reservedThread = existing;
				thread = existing;
				agent = existing.definition.name;
				displayName = existing.displayName;
				threadId = existing.id;
				definition = existing.definition;
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
			} else {
				phase = "discovery";
				const resolved = await resolveFreshDefinition();
				if (!this.isLive(generation, combined)) return abortNow();
				if (!resolved.ok) return fail(resolved.error, resolved.phase);
				definition = resolved.definition;
				agent = definition.name;
				displayName = this.assignDisplayName(definition);
				threadId = `thread-${this.nextThreadId++}`;
				fanOut({ ...active.snapshot, agent, displayName, threadId }, true);

				const reserved = this.reserveFreshCapacity();
				if (!reserved.ok) return fail(reserved.error, "queue");
				reservationToken = reserved.token;
				if (reserved.evicted) await this.disposeThread(reserved.evicted);
			}

			// FIFO barrier assigned at execute() entry — earlier tickets go first regardless of discovery speed.
			const admitted = await this.waitAdmitTicket(admitTicket, combined, generation);
			if (!admitted) return abortNow(phase, true);

			if (thread) {
				releaseThread = await thread.turnGate.acquire(combined);
				if (thread.disposed || this.threads.get(thread.id) !== thread) {
					this.advanceAdmitTicket(admitTicket);
					admitAdvanced = true;
					return fail(`Subagent thread ${thread.id} is unavailable after queueing`, "queue", {
						status: combined.aborted ? "aborted" : "failed",
						model: thread.model,
						thinkingLevel: thread.thinkingLevel,
						threadId: thread.id,
					});
				}
			}
			if (!this.isLive(generation, combined)) return abortNow(phase, true);

			try {
				releaseGlobal = await this.globalGate.acquire(combined);
			} catch {
				return abortNow(phase, true);
			}
			// Next ticket may compete for remaining global slots.
			this.advanceAdmitTicket(admitTicket);
			admitAdvanced = true;
			if (!this.isLive(generation, combined)) return abortNow();

			if (!thread) {
				phase = "startup";
				if (!threadId || !definition) throw new Error("Subagent startup state is incomplete");
				const selectedDefinition = definition;
				fanOut({ ...active.snapshot, status: "starting", phase: "startup", agent, threadId }, true);
				const created = asTracked(
					await createSubagentThread({
						id: threadId,
						displayName,
						definition: selectedDefinition,
						extensionPaths: extensionPathsForTools(this.pi, selectedDefinition.tools),
						initialTask: task,
						ctx,
						thinkingLevel: parentThinking,
						signal: combined,
						onWarning: (warning) => {
							const message = `Subagent definition ${selectedDefinition.path}: ${warning}`;
							if (this.runtimeWarnings.has(message)) return;
							this.runtimeWarnings.add(message);
							ctx.ui.notify(message, "warning");
						},
					}),
				);
				if (!this.isLive(generation, combined)) {
					await this.disposeThread(created);
					thread = created;
					return abortNow("startup");
				}
				provisionalThread = created;
				thread = created;
				thread.pendingTurns += 1;
				reservedThread = thread;
			}

			const result = await runSubagentTurn({
				thread,
				task,
				initial: thread.turns === 0,
				signal: combined,
				onUpdate: (details) => {
					fanOut({ ...details, invocationId, threadId: thread?.id ?? threadId });
				},
			});

			if (!this.isLive(generation, combined)) {
				const details = {
					...result.details,
					status: "aborted" as const,
					invocationId,
					error: result.details.error ?? "Subagent session reset",
				};
				fanOut(details, true);
				this.releaseReservation(reservationToken);
				reservationToken = undefined;
				if (provisionalThread) {
					await this.disposeThread(provisionalThread);
					provisionalThread = undefined;
				} else if (thread && this.threads.get(thread.id) === thread) {
					this.threads.delete(thread.id);
					await this.disposeThread(thread);
				}
				return {
					content: [{ type: "text", text: details.error ?? "aborted" }],
					details,
				};
			}

			lastPublishedStatus = result.details.status;

			// Drop reservation before publish so capacity never reads above 16.
			this.releaseReservation(reservationToken);
			reservationToken = undefined;
			const retained = await this.finalizeThreadRetention({
				generation,
				continuing,
				thread,
				provisional: provisionalThread === thread,
				result,
			});
			provisionalThread = undefined;

			if (!retained) {
				return {
					content: [{ type: "text", text: result.content }],
					details: { ...result.details, displayName: thread.displayName, invocationId, threadId: thread.id },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Thread: ${thread.id}\nReuse with subagent({ thread: "${thread.id}", task: "..." })\n\n${result.content}`,
					},
				],
				details: { ...result.details, displayName: thread.displayName, invocationId, threadId: thread.id },
			};
		} catch (error) {
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
			if (provisionalThread) {
				await this.disposeThread(provisionalThread);
				provisionalThread = undefined;
			} else if (thread && continuing && this.threads.get(thread.id) === thread) {
				this.threads.delete(thread.id);
				await this.disposeThread(thread);
			}
			return { content: [{ type: "text", text: message }], details };
		} finally {
			if (!admitAdvanced) this.advanceAdmitTicket(admitTicket);
			this.releaseReservation(reservationToken);
			if (provisionalThread && this.threads.get(provisionalThread.id) !== provisionalThread) {
				await this.disposeThread(provisionalThread).catch(() => undefined);
			}
			if (reservedThread) reservedThread.pendingTurns = Math.max(0, reservedThread.pendingTurns - 1);
			releaseGlobal?.();
			releaseThread?.();
			this.controllers.delete(controller);
			this.invocations.delete(invocationId);
		}
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
