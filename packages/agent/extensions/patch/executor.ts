import { access, mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyChunksWithRanges, countLogicalLines, UpdateChunkApplyError } from "./matcher.ts";
import { type PatchFailure, type PatchOperation, parsePatch } from "./parser.ts";

export interface ApplyPatchChange {
	sectionIndex: number;
	kind: PatchOperation["type"];
	path: string;
	move?: { from: string; to: string };
	linesAdded: number;
	linesRemoved: number;
	snapshotRanges?: Array<{ startLine: number; endLine: number }>;
}

export interface ApplyPatchSummary {
	status: "completed" | "partial" | "failed";
	changes: ApplyPatchChange[];
	failures: PatchFailure[];
	totalSections: number;
}

export interface ApplyPatchStats {
	added: string[];
	replaced: string[];
	updated: string[];
	deleted: string[];
	moved: Array<{ from: string; to: string }>;
	linesAdded: number;
	linesRemoved: number;
	completedOperations: number;
}

export function deriveStats(summary: ApplyPatchSummary): ApplyPatchStats {
	const added: string[] = [];
	const replaced: string[] = [];
	const updated: string[] = [];
	const deleted: string[] = [];
	const moved: Array<{ from: string; to: string }> = [];
	let linesAdded = 0;
	let linesRemoved = 0;
	for (const c of summary.changes) {
		if (c.kind === "add") added.push(c.path);
		else if (c.kind === "replace") replaced.push(c.path);
		else if (c.kind === "delete") deleted.push(c.path);
		else {
			updated.push(c.move?.to ?? c.path);
			if (c.move) moved.push(c.move);
		}
		linesAdded += c.linesAdded;
		linesRemoved += c.linesRemoved;
	}
	return {
		added,
		replaced,
		updated,
		deleted,
		moved,
		linesAdded,
		linesRemoved,
		completedOperations: summary.changes.length,
	};
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

async function readUtf8(path: string, displayPath: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		const message = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
		throw new Error(`Could not read file: ${displayPath}. ${message}.`);
	}
}

async function assertExistingFile(path: string, displayPath: string): Promise<void> {
	if (!(await pathExists(path))) throw new Error(`Path does not exist: ${displayPath}`);
	const info = await stat(path);
	if (!info.isFile()) throw new Error(`Expected a file: ${displayPath}`);
}

async function removeEmptyParentDirs(cwd: string, startDir: string): Promise<void> {
	let current = resolve(startDir);
	const root = resolve(cwd);
	while (current !== root) {
		const rel = relative(root, current);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
		try {
			await rmdir(current);
		} catch {
			return;
		}
		current = dirname(current);
	}
}

async function stageWholeFile(
	cwd: string,
	op: Extract<PatchOperation, { type: "add" | "replace" }>,
): Promise<StagedMutation> {
	const target = resolvePath(cwd, op.path);
	let linesRemoved = 0;
	if (await pathExists(target)) {
		linesRemoved = countLogicalLines(await readUtf8(target, op.path));
	}
	const lineCount = countLogicalLines(op.content);
	return {
		change: {
			sectionIndex: op.sectionIndex,
			kind: op.type,
			path: op.path,
			linesAdded: op.linesAdded,
			linesRemoved,
			snapshotRanges: lineCount > 0 ? [{ startLine: 1, endLine: Math.min(lineCount, 120) }] : undefined,
		},
		async commit() {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, op.content, "utf8");
		},
	};
}

async function stageDelete(cwd: string, op: Extract<PatchOperation, { type: "delete" }>): Promise<StagedMutation> {
	const target = resolvePath(cwd, op.path);
	await assertExistingFile(target, op.path);
	const current = await readUtf8(target, op.path);
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
			await removeEmptyParentDirs(cwd, dirname(target));
		},
	};
}

async function stageUpdate(cwd: string, op: Extract<PatchOperation, { type: "update" }>): Promise<StagedMutation> {
	const source = resolvePath(cwd, op.path);
	await assertExistingFile(source, op.path);
	const current = await readUtf8(source, op.path);
	const result = op.chunks.length > 0 ? applyChunksWithRanges(current, op.chunks) : undefined;
	const next = result?.content ?? current;
	const moveTarget = op.movePath ? resolvePath(cwd, op.movePath) : undefined;

	if (!moveTarget || moveTarget === source) {
		return {
			change: {
				sectionIndex: op.sectionIndex,
				kind: "update",
				path: op.path,
				linesAdded: op.linesAdded,
				linesRemoved: op.linesRemoved,
				snapshotRanges: result?.snapshotRanges,
			},
			async commit() {
				await writeFile(source, next, "utf8");
			},
		};
	}

	const movePath = op.movePath;
	if (!movePath) throw new Error("Move target path is missing.");
	if (await pathExists(moveTarget)) {
		throw new Error(
			`move target already exists: ${movePath}. Move targets must be unused to avoid overwriting existing files.`,
		);
	}
	return {
		change: {
			sectionIndex: op.sectionIndex,
			kind: "update",
			path: movePath,
			move: { from: op.path, to: movePath },
			linesAdded: op.linesAdded,
			linesRemoved: op.linesRemoved,
			snapshotRanges: result?.snapshotRanges,
		},
		async commit() {
			await mkdir(dirname(moveTarget), { recursive: true });
			await writeFile(moveTarget, next, "utf8");
			await unlink(source);
			await removeEmptyParentDirs(cwd, dirname(source));
		},
	};
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
		const display = displayPaths.get(canonical) ?? canonical;
		for (const sectionIndex of sections) {
			failures.push({
				phase: "apply",
				sectionIndex,
				path: display,
				message: `conflicting operations for path: ${display} (sections ${sections.join(", ")}). Use Add File or Replace File for whole-file writes, or split dependent changes into separate patches.`,
			});
		}
	}
	return failures;
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

export async function applyPatch(
	cwd: string,
	input: string,
	signal?: AbortSignal,
	onProgress?: (summary: ApplyPatchSummary) => void | Promise<void>,
): Promise<ApplyPatchSummary> {
	throwIfAborted(signal);
	const { operations, parseFailures, totalSections } = parsePatch(input);

	if (operations.length === 0) {
		const summary: ApplyPatchSummary = {
			status: "failed",
			changes: [],
			failures: parseFailures,
			totalSections: totalSections || 1,
		};
		await onProgress?.(summary);
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
				if (op.type === "add" || op.type === "replace") staged.push(await stageWholeFile(cwd, op));
				else if (op.type === "delete") staged.push(await stageDelete(cwd, op));
				else staged.push(await stageUpdate(cwd, op));
			} catch (error) {
				if (error instanceof Error && error.message === "Operation aborted") throw error;
				const failure: PatchFailure = {
					phase: "apply",
					sectionIndex: op.sectionIndex,
					path: op.path,
					kind: op.type,
					message: error instanceof Error ? error.message : String(error),
				};
				if (error instanceof UpdateChunkApplyError) {
					failure.chunkIndex = error.chunkIndex;
					failure.totalChunks = error.totalChunks;
					failure.contextHint = error.contextHint;
				}
				failures.push(failure);
			}
		}

		if (staged.length === 0) {
			const summary: ApplyPatchSummary = { status: "failed", changes: [], failures, totalSections };
			await onProgress?.(summary);
			return summary;
		}

		throwIfAborted(signal);

		const changes: ApplyPatchChange[] = [];
		for (const mutation of staged) {
			try {
				await mutation.commit();
				changes.push(mutation.change);
				await onProgress?.({ status: "partial", changes: [...changes], failures: [...failures], totalSections });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push({
					phase: "apply",
					sectionIndex: mutation.change.sectionIndex,
					path: mutation.change.path,
					kind: mutation.change.kind,
					message,
				});
				const status = changes.length === 0 ? "failed" : "partial";
				const summary: ApplyPatchSummary = {
					status,
					changes: [...changes],
					failures: [...failures],
					totalSections,
				};
				await onProgress?.(summary);
				return summary;
			}
		}

		const status: ApplyPatchSummary["status"] = failures.length > 0 ? "partial" : "completed";
		return { status, changes, failures, totalSections };
	});
}
