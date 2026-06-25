import { access, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyChunks, countLogicalLines, formatContextHint, UpdateChunkApplyError } from "./matcher.ts";
import { type PatchFailure, type PatchOperation, parsePatch } from "./parser.ts";

export interface ApplyPatchChange {
	sectionIndex: number;
	kind: PatchOperation["type"];
	path: string;
	move?: { from: string; to: string };
	linesAdded: number;
	linesRemoved: number;
}

export interface ApplyPatchSummary {
	status: "completed" | "partial" | "failed";
	added: string[];
	updated: string[];
	deleted: string[];
	moved: Array<{ from: string; to: string }>;
	linesAdded: number;
	linesRemoved: number;
	changes: ApplyPatchChange[];
	failures: PatchFailure[];
	completedOperations: number;
	totalOperations: number;
}

interface StagedMutation {
	change: ApplyPatchChange;
	commit(): Promise<void>;
}

// lean: resolve(cwd,path) without realpath collapse; OK for typical working trees without symlinked dirs;
// upgrade to realpath ancestor walk when symlink-based dedup collisions appear
function resolvePath(cwd: string, rawPath: string): string {
	const input = rawPath.trim();
	if (!input) throw new Error("Path must not be empty.");
	return isAbsolute(input) ? resolve(input) : resolve(cwd, input);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readUtf8(path: string, displayPath: string, signal: AbortSignal | undefined): Promise<string> {
	throwIfAborted(signal);
	try {
		const content = await readFile(path, "utf8");
		throwIfAborted(signal);
		return content;
	} catch (error) {
		throwIfAborted(signal);
		const message = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
		throw new Error(`Could not read file: ${displayPath}. ${message}.`);
	}
}

async function assertExistingFile(path: string, displayPath: string, signal: AbortSignal | undefined): Promise<void> {
	throwIfAborted(signal);
	if (!(await pathExists(path))) throw new Error(`Path does not exist: ${displayPath}`);
	throwIfAborted(signal);
	const info = await stat(path);
	throwIfAborted(signal);
	if (!info.isFile()) throw new Error(`Expected a file: ${displayPath}`);
}

async function stageAdd(
	cwd: string,
	op: Extract<PatchOperation, { type: "add" }>,
	signal: AbortSignal | undefined,
): Promise<StagedMutation> {
	const target = resolvePath(cwd, op.path);
	let linesRemoved = 0;
	if (await pathExists(target)) {
		const current = await readUtf8(target, op.path, signal);
		linesRemoved = countLogicalLines(current);
	}
	throwIfAborted(signal);
	return {
		change: { sectionIndex: op.sectionIndex, kind: "add", path: op.path, linesAdded: op.linesAdded, linesRemoved },
		async commit() {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, op.content, "utf8");
		},
	};
}

async function stageDelete(
	cwd: string,
	op: Extract<PatchOperation, { type: "delete" }>,
	signal: AbortSignal | undefined,
): Promise<StagedMutation> {
	const target = resolvePath(cwd, op.path);
	await assertExistingFile(target, op.path, signal);
	const current = await readUtf8(target, op.path, signal);
	return {
		change: {
			sectionIndex: op.sectionIndex,
			kind: "delete",
			path: op.path,
			linesAdded: 0,
			linesRemoved: countLogicalLines(current),
		},
		async commit() {
			await unlink(target);
		},
	};
}

async function stageUpdate(
	cwd: string,
	op: Extract<PatchOperation, { type: "update" }>,
	signal: AbortSignal | undefined,
): Promise<StagedMutation> {
	const source = resolvePath(cwd, op.path);
	await assertExistingFile(source, op.path, signal);
	const current = await readUtf8(source, op.path, signal);

	let next = current;
	if (op.chunks.length > 0) {
		try {
			next = applyChunks(current, op.chunks);
		} catch (error) {
			if (error instanceof UpdateChunkApplyError) throw new ChunkApplyFailure(op, error);
			throw error;
		}
	}

	const moveTarget = op.movePath ? resolvePath(cwd, op.movePath) : undefined;

	if (!moveTarget || moveTarget === source) {
		if (next === current) throw new Error("patch produced no changes");
		return {
			change: {
				sectionIndex: op.sectionIndex,
				kind: "update",
				path: op.path,
				linesAdded: op.linesAdded,
				linesRemoved: op.linesRemoved,
			},
			async commit() {
				await writeFile(source, next, "utf8");
			},
		};
	}

	if (await pathExists(moveTarget)) {
		throw new Error(
			`move target already exists: ${op.movePath}. Move targets must be unused to avoid overwriting existing files.`,
		);
	}
	throwIfAborted(signal);
	return {
		change: {
			sectionIndex: op.sectionIndex,
			kind: "update",
			path: op.movePath!,
			move: { from: op.path, to: op.movePath! },
			linesAdded: op.linesAdded,
			linesRemoved: op.linesRemoved,
		},
		async commit() {
			await mkdir(dirname(moveTarget), { recursive: true });
			await writeFile(moveTarget, next, "utf8");
			await unlink(source);
		},
	};
}

class ChunkApplyFailure extends Error {
	chunkIndex: number;
	totalChunks: number;
	contextHint?: string;

	constructor(op: Extract<PatchOperation, { type: "update" }>, error: UpdateChunkApplyError) {
		const hint = error.contextHint ?? formatContextHint(op.chunks[error.chunkIndex - 1]!);
		super(error.message);
		this.name = "ChunkApplyFailure";
		this.chunkIndex = error.chunkIndex;
		this.totalChunks = error.totalChunks;
		this.contextHint = hint;
	}
}

function collectDupPathFailures(cwd: string, operations: PatchOperation[]): PatchFailure[] {
	const pathSections = new Map<string, number[]>();
	const displayPaths = new Map<string, string>();

	for (const op of operations) {
		const paths = [resolvePath(cwd, op.path)];
		if (op.type === "update" && op.movePath) paths.push(resolvePath(cwd, op.movePath));

		for (const p of paths) {
			const existing = pathSections.get(p) ?? [];
			existing.push(op.sectionIndex);
			pathSections.set(p, existing);
			if (!displayPaths.has(p)) displayPaths.set(p, op.path);
		}
	}

	const failures: PatchFailure[] = [];
	for (const [canonical, sections] of pathSections) {
		if (sections.length <= 1) continue;
		const display = displayPaths.get(canonical)!;
		for (const sectionIndex of sections) {
			failures.push({
				phase: "apply",
				sectionIndex,
				path: display,
				message: `conflicting operations for path: ${display} (sections ${sections.join(", ")}). Use Add File to overwrite, or split dependent changes into separate patches.`,
			});
		}
	}
	return failures;
}

function emptySummary(totalOperations: number, failures: PatchFailure[] = []): ApplyPatchSummary {
	return {
		status: "failed",
		added: [],
		updated: [],
		deleted: [],
		moved: [],
		linesAdded: 0,
		linesRemoved: 0,
		changes: [],
		failures,
		completedOperations: 0,
		totalOperations,
	};
}

function snapshot(summary: ApplyPatchSummary): ApplyPatchSummary {
	return {
		...summary,
		added: [...summary.added],
		updated: [...summary.updated],
		deleted: [...summary.deleted],
		moved: summary.moved.map((m) => ({ ...m })),
		changes: summary.changes.map((c) => ({ ...c, move: c.move ? { ...c.move } : undefined })),
		failures: summary.failures.map((f) => ({ ...f })),
	};
}

function withMutationQueuePaths<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
	const unique = Array.from(new Set(paths)).sort();
	let current = fn;
	for (const path of unique.reverse()) {
		const next = current;
		current = () => withFileMutationQueue(path, next);
	}
	return current();
}

function recordChange(summary: ApplyPatchSummary, change: ApplyPatchChange): void {
	summary.changes.push(change);
	if (change.kind === "add") summary.added.push(change.path);
	else if (change.kind === "delete") summary.deleted.push(change.path);
	else {
		summary.updated.push(change.move?.to ?? change.path);
		if (change.move) summary.moved.push(change.move);
	}
	summary.linesAdded += change.linesAdded;
	summary.linesRemoved += change.linesRemoved;
	summary.completedOperations = summary.changes.length;
}

export async function applyPatch(
	cwd: string,
	input: string,
	signal?: AbortSignal,
	onProgress?: (summary: ApplyPatchSummary) => void | Promise<void>,
): Promise<ApplyPatchSummary> {
	throwIfAborted(signal);
	const { operations, parseFailures, totalSections } = parsePatch(input);
	const totalOperations = totalSections;

	if (operations.length === 0) {
		const summary = emptySummary(totalOperations || 1, parseFailures);
		await onProgress?.(snapshot(summary));
		return summary;
	}

	const dupFailures = collectDupPathFailures(cwd, operations);
	const initialFailures = [...parseFailures, ...dupFailures];
	const blockedSections = new Set(initialFailures.map((failure) => failure.sectionIndex));
	const runnableOperations = operations.filter((op) => !blockedSections.has(op.sectionIndex));

	const queuePaths = runnableOperations.flatMap((op) => {
		const paths = [resolvePath(cwd, op.path)];
		if (op.type === "update" && op.movePath) paths.push(resolvePath(cwd, op.movePath));
		return paths;
	});

	return withMutationQueuePaths(queuePaths, async () => {
		const staged: StagedMutation[] = [];
		const failures: PatchFailure[] = [...initialFailures];

		for (const op of runnableOperations) {
			try {
				let mutation: StagedMutation;
				if (op.type === "add") mutation = await stageAdd(cwd, op, signal);
				else if (op.type === "delete") mutation = await stageDelete(cwd, op, signal);
				else mutation = await stageUpdate(cwd, op, signal);
				staged.push(mutation);
			} catch (error) {
				if (error instanceof Error && error.message === "Operation aborted") throw error;
				const message = error instanceof Error ? error.message : String(error);
				const failure: PatchFailure = {
					phase: "apply",
					sectionIndex: op.sectionIndex,
					path: op.path,
					kind: op.type,
					message,
				};
				if (error instanceof ChunkApplyFailure) {
					failure.chunkIndex = error.chunkIndex;
					failure.totalChunks = error.totalChunks;
					failure.contextHint = error.contextHint;
				}
				failures.push(failure);
			}
		}

		if (staged.length === 0) {
			const summary = emptySummary(totalOperations, failures);
			await onProgress?.(snapshot(summary));
			return summary;
		}

		throwIfAborted(signal);
		const summary: ApplyPatchSummary = emptySummary(totalOperations, []);
		summary.failures.push(...failures);
		summary.status = failures.length > 0 ? "partial" : "completed";

		for (const mutation of staged) {
			try {
				await mutation.commit();
				recordChange(summary, mutation.change);
				await onProgress?.(snapshot(summary));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				summary.failures.push({
					phase: "apply",
					sectionIndex: mutation.change.sectionIndex,
					path: mutation.change.path,
					kind: mutation.change.kind,
					message,
				});
				summary.status = summary.changes.length === 0 ? "failed" : "partial";
				await onProgress?.(snapshot(summary));
				return summary;
			}
		}

		summary.status = summary.failures.length > 0 ? "partial" : "completed";
		return summary;
	});
}
