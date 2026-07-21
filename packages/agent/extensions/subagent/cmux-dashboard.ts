import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { SubagentInvocationSnapshot } from "./run.ts";

const WRITE_DEBOUNCE_MS = 150;
const CLOSE_DELAY_MS = 2000;
const CMUX_TIMEOUT_MS = 2500;
const DASHBOARD_FILENAME = "dashboard.md";

export type CmuxExec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface CmuxClock {
	now(): number;
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface CmuxDashboardOptions {
	exec: CmuxExec;
	clock?: CmuxClock;
	env?: NodeJS.ProcessEnv;
	notify?: (message: string) => void;
	/** When false, never open a new surface (unresolved prior orphans). */
	canOpen?: () => boolean;
}

export interface DashboardOrphan {
	workspaceId?: string;
	surfaceId?: string;
	directory: string;
	path: string;
}

export interface CmuxDashboard {
	/** Soft enable for interactive TUI sessions. Env still required. */
	setInteractive(enabled: boolean): void;
	onSnapshot(snapshot: SubagentInvocationSnapshot): void;
	/** Close owned surface. Returns orphans that still need ownership/retry. */
	shutdown(): Promise<DashboardOrphan[]>;
}

interface OwnedSurface {
	workspaceId: string;
	surfaceId: string;
	directory: string;
	path: string;
}

/** Directory retained after ambiguous open until shutdown can best-effort clean. */
interface RetainedDirectory {
	directory: string;
	path: string;
}

function defaultClock(): CmuxClock {
	return {
		now: () => Date.now(),
		setTimeout: (handler, ms) => setTimeout(handler, ms),
		clearTimeout: (handle) => {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		},
	};
}

function cap(text: string | undefined, limit: number): string {
	if (!text) return "";
	const normalized = text.replace(/\r\n/g, "\n").trimEnd();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, limit - 1)}…`;
}

export function formatDashboardMarkdown(snapshots: readonly SubagentInvocationSnapshot[]): string {
	const ordered = [...snapshots].sort(
		(a, b) => a.startedAt - b.startedAt || a.invocationId.localeCompare(b.invocationId),
	);
	const activeCount = ordered.filter(
		(snapshot) => snapshot.status !== "completed" && snapshot.status !== "failed" && snapshot.status !== "aborted",
	).length;
	const lines = [
		"# Subagent dashboard",
		"",
		`Active: ${activeCount} · Completed: ${ordered.length - activeCount}`,
		"",
	];
	if (ordered.length === 0) {
		lines.push("_No active invocations._", "");
		return lines.join("\n");
	}
	for (const details of ordered) {
		const identity = `${details.displayName} (${details.agent})`;
		lines.push(
			`## ${identity}`,
			"",
			`\`${details.status}${details.phase ? ` · ${details.phase}` : ""}\` · inv ${details.invocationId} · tools ${details.toolCalls} · ${(details.durationMs / 1000).toFixed(1)}s`,
			`model ${details.model} · thinking ${details.thinkingLevel}`,
			"",
			"### Task",
			"",
			cap(details.task, 1200) || "_(empty)_",
		);
		if (details.currentActivity) {
			lines.push("", "### Current", "", cap(details.currentActivity, 400));
		}
		if (details.actions.length > 0) {
			lines.push("", "### Actions", "");
			for (const action of details.actions.slice(-12)) {
				const mark = action.error ? "!" : "·";
				lines.push(`- ${mark} ${cap(action.summary, 200)}`);
			}
			if (details.omittedActions > 0) {
				lines.push(`- _${details.omittedActions} earlier actions omitted_`);
			}
		}
		if (details.response) {
			lines.push("", "### Response", "", cap(details.response, 3000));
		}
		if (details.error) {
			lines.push("", "### Error", "", cap(details.error, 800));
		}
		lines.push("");
	}
	return lines.join("\n");
}

function parseOpenResult(stdout: string): { workspaceId?: string; surfaceId?: string } {
	const parsed = JSON.parse(stdout) as {
		surface_id?: string;
		surface_ref?: string;
		workspace_id?: string;
		workspace_ref?: string;
		result?: {
			surface_id?: string;
			surface_ref?: string;
			workspace_id?: string;
			workspace_ref?: string;
		};
	};
	const body = parsed.result ?? parsed;
	const surfaceId =
		typeof body.surface_id === "string" && body.surface_id
			? body.surface_id
			: typeof body.surface_ref === "string" && body.surface_ref
				? body.surface_ref
				: undefined;
	const workspaceId =
		typeof body.workspace_id === "string" && body.workspace_id
			? body.workspace_id
			: typeof body.workspace_ref === "string" && body.workspace_ref
				? body.workspace_ref
				: undefined;
	return { surfaceId, workspaceId };
}

function surfaceGone(result: ExecResult): boolean {
	return /not found|unknown surface|no such/i.test(`${result.stderr}\n${result.stdout}`);
}

/**
 * One session-owned Markdown surface for all active subagent invocations.
 * Never blocks the child scheduler — all work is fire-and-forget from the runtime.
 */
export function createCmuxDashboard(options: CmuxDashboardOptions): CmuxDashboard {
	const exec = options.exec;
	const clock = options.clock ?? defaultClock();
	const env = options.env ?? process.env;
	const notify = options.notify;
	const canOpen = options.canOpen ?? (() => true);

	const parentWorkspaceId = env.CMUX_WORKSPACE_ID;
	const parentSurfaceId = env.CMUX_SURFACE_ID;
	const envAvailable = Boolean(parentWorkspaceId && parentSurfaceId);

	let interactive = false;
	let disabled = !envAvailable;
	let shuttingDown = false;
	let shutdownPromise: Promise<DashboardOrphan[]> | undefined;
	let notifiedFailure = false;
	let owned: OwnedSurface | undefined;
	/** Ambiguous opens: keep dir tracked until shutdown. */
	const retainedDirs = new Set<RetainedDirectory>();
	let openPromise: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;
	let closeTimer: unknown;
	let writeTimer: unknown;
	let writeChain = Promise.resolve();
	let opChain = Promise.resolve();
	const active = new Map<string, SubagentInvocationSnapshot>();
	const hasLiveInvocations = (): boolean =>
		[...active.values()].some(
			(snapshot) => snapshot.status !== "completed" && snapshot.status !== "failed" && snapshot.status !== "aborted",
		);
	const removeTerminalInvocations = (): void => {
		for (const [invocationId, snapshot] of active) {
			if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "aborted") {
				active.delete(invocationId);
			}
		}
	};

	const enqueueOp = (fn: () => Promise<void>): Promise<void> => {
		const next = opChain.then(fn, fn);
		opChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	const cmuxRpc = async (method: string, params: Record<string, unknown>): Promise<ExecResult> => {
		return exec("cmux", ["--json", "--id-format", "both", "rpc", method, JSON.stringify(params)], {
			timeout: CMUX_TIMEOUT_MS,
		});
	};

	const writeAtomic = async (path: string, content: string): Promise<void> => {
		const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
		await rename(temp, path);
	};

	const flushWrite = (): Promise<void> => {
		const path = owned?.path;
		if (!path) return Promise.resolve();
		const content = formatDashboardMarkdown([...active.values()]);
		writeChain = writeChain.then(() => writeAtomic(path, content)).catch(() => undefined);
		return writeChain;
	};

	const scheduleWrite = (immediate: boolean): void => {
		if (!owned || shuttingDown) return;
		if (immediate) {
			if (writeTimer !== undefined) {
				clock.clearTimeout(writeTimer);
				writeTimer = undefined;
			}
			void flushWrite();
			return;
		}
		if (writeTimer !== undefined) return;
		writeTimer = clock.setTimeout(() => {
			writeTimer = undefined;
			void flushWrite();
		}, WRITE_DEBOUNCE_MS);
	};

	const cancelCloseTimer = (): void => {
		if (closeTimer === undefined) return;
		clock.clearTimeout(closeTimer);
		closeTimer = undefined;
	};

	const failOnce = (message: string): void => {
		disabled = true;
		if (notifiedFailure) return;
		notifiedFailure = true;
		notify?.(message);
	};

	const retainDirectory = (directory: string, path: string): void => {
		retainedDirs.add({ directory, path });
	};

	const ensureOpen = (): void => {
		if (disabled || shuttingDown || !interactive || !envAvailable || !parentWorkspaceId || !parentSurfaceId) return;
		if (!canOpen()) return;
		if (owned || openPromise || closePromise) return;
		openPromise = enqueueOp(async () => {
			if (disabled || shuttingDown || owned || closePromise) return;
			let directory: string | undefined;
			let path: string | undefined;
			let openAttempted = false;
			try {
				directory = await mkdtemp(join(tmpdir(), "tau-subagent-dashboard-"));
				path = join(directory, DASHBOARD_FILENAME);
				await writeAtomic(path, formatDashboardMarkdown([...active.values()]));
				openAttempted = true;
				const result = await cmuxRpc("markdown.open", {
					path,
					workspace_id: parentWorkspaceId,
					surface_id: parentSurfaceId,
					direction: "right",
					focus: false,
				});
				if (result.code !== 0 || result.killed) {
					// Surface may still exist after timeout/kill. Keep directory owned.
					retainDirectory(directory, path);
					directory = undefined;
					failOnce("Subagent cmux dashboard unavailable; continuing without live pane.");
					return;
				}
				let parsed: { surfaceId?: string; workspaceId?: string };
				try {
					parsed = parseOpenResult(result.stdout);
				} catch {
					retainDirectory(directory, path);
					directory = undefined;
					failOnce("Subagent cmux dashboard returned malformed open output; disabling for this session.");
					return;
				}
				if (!parsed.surfaceId) {
					retainDirectory(directory, path);
					directory = undefined;
					failOnce("Subagent cmux dashboard open missing surface id; disabling for this session.");
					return;
				}
				owned = {
					workspaceId: parsed.workspaceId ?? parentWorkspaceId,
					surfaceId: parsed.surfaceId,
					directory,
					path,
				};
				directory = undefined;
				await flushWrite();
				if (!hasLiveInvocations()) scheduleCloseIfIdle();
			} catch {
				if (openAttempted && directory && path) retainDirectory(directory, path);
				else if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
				failOnce("Subagent cmux dashboard failed to open; continuing without live pane.");
			} finally {
				openPromise = undefined;
				// A close may have been requested while opening; or new work arrived after a prior close race.
				if (!shuttingDown && hasLiveInvocations() && !owned && !disabled) ensureOpen();
			}
		});
	};

	const closeOwned = async (): Promise<void> => {
		cancelCloseTimer();
		if (writeTimer !== undefined) {
			clock.clearTimeout(writeTimer);
			writeTimer = undefined;
		}
		const current = owned;
		if (!current) return;
		// Recheck cohort immediately before RPC.
		if (hasLiveInvocations()) return;
		await writeChain.catch(() => undefined);
		if (hasLiveInvocations()) return;
		const result = await cmuxRpc("surface.close", {
			workspace_id: current.workspaceId,
			surface_id: current.surfaceId,
		}).catch(() => ({ stdout: "", stderr: "close failed", code: 1, killed: false }));
		if (hasLiveInvocations()) {
			// New work arrived during close RPC.
			const closed = result.code === 0 && !result.killed;
			if (closed || surfaceGone(result)) {
				owned = undefined;
				removeTerminalInvocations();
				await rm(current.directory, { recursive: true, force: true }).catch(() => undefined);
				ensureOpen();
			}
			// Unknown failure: keep ownership so the live surface still has a file.
			return;
		}
		const closed = result.code === 0 && !result.killed;
		if (closed || surfaceGone(result)) {
			owned = undefined;
			active.clear();
			await rm(current.directory, { recursive: true, force: true }).catch(() => undefined);
			return;
		}
		// Unknown failure: keep ownership and backing file.
	};

	const scheduleCloseIfIdle = (): void => {
		if (shuttingDown || hasLiveInvocations() || !owned || closePromise) return;
		cancelCloseTimer();
		closeTimer = clock.setTimeout(() => {
			closeTimer = undefined;
			if (shuttingDown || hasLiveInvocations() || closePromise) return;
			closePromise = enqueueOp(async () => {
				try {
					if (shuttingDown || hasLiveInvocations()) return;
					await closeOwned();
				} finally {
					closePromise = undefined;
					if (!shuttingDown && hasLiveInvocations() && !owned && !disabled) ensureOpen();
				}
			});
		}, CLOSE_DELAY_MS);
	};

	return {
		setInteractive(enabled: boolean) {
			if (shuttingDown) return;
			interactive = enabled;
		},
		onSnapshot(snapshot: SubagentInvocationSnapshot) {
			if (disabled || shuttingDown || !interactive) return;
			const terminal =
				snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "aborted";
			cancelCloseTimer();
			if (terminal) {
				// Keep completed work visible while the rest of the cohort runs.
				active.set(snapshot.invocationId, snapshot);
				ensureOpen();
				void flushWrite().then(() => {
					if (shuttingDown) return;
					if (!hasLiveInvocations()) scheduleCloseIfIdle();
				});
				return;
			}
			active.set(snapshot.invocationId, snapshot);
			if (closePromise) {
				// Close in flight — reopen path runs when close finishes if still active.
			} else {
				ensureOpen();
			}
			scheduleWrite(snapshot.status === "starting" || snapshot.status === "running");
		},
		async shutdown() {
			if (shutdownPromise) return shutdownPromise;
			shuttingDown = true;
			disabled = true;
			interactive = false;
			cancelCloseTimer();
			if (writeTimer !== undefined) {
				clock.clearTimeout(writeTimer);
				writeTimer = undefined;
			}
			active.clear();
			shutdownPromise = (async () => {
				const orphans: DashboardOrphan[] = [];
				if (openPromise) await openPromise.catch(() => undefined);
				if (closePromise) await closePromise.catch(() => undefined);
				await enqueueOp(async () => {
					if (owned) {
						await flushWrite();
						const current = owned;
						const result = await cmuxRpc("surface.close", {
							workspace_id: current.workspaceId,
							surface_id: current.surfaceId,
						}).catch(() => ({ stdout: "", stderr: "close failed", code: 1, killed: false }));
						const closed = result.code === 0 && !result.killed;
						if (closed || surfaceGone(result)) {
							owned = undefined;
							await rm(current.directory, { recursive: true, force: true }).catch(() => undefined);
						} else {
							// Transfer ownership out so extension can retry later.
							orphans.push({ ...current });
							owned = undefined;
						}
					}
				});
				for (const item of retainedDirs) orphans.push({ directory: item.directory, path: item.path });
				retainedDirs.clear();
				return orphans;
			})();
			return shutdownPromise;
		},
	};
}
