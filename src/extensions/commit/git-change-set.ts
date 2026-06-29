import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GitRunner } from "../../shared/git.ts";
import { truncAt } from "../../shared/text.ts";

const COMMIT_TIMEOUT_MS = 120_000;
const EVIDENCE_CONCURRENCY = 4;
const MAX_FILE_EVIDENCE_CHARS = 4_000;
const MAX_INTENT_CHARS = 8_000;
const MAX_UNTRACKED_PREVIEW_BYTES = 12_000;

export interface CommitEvidence {
	recentSubjects: string;
	intent: readonly string[];
	files: readonly DirtyFile[];
}

export interface DirtyFile {
	id: number;
	path: string;
	status: string;
	kind: "modified" | "added" | "deleted" | "renamed" | "untracked";
	untracked: boolean;
	evidence: string;
	renamedFrom?: string;
}

interface ParsedDirtyFile {
	path: string;
	status: string;
	untracked: boolean;
	renamedFrom?: string;
}

export async function loadChangeSet(
	git: GitRunner,
	root: string,
	entries: readonly SessionEntry[],
	markerType: string,
): Promise<CommitEvidence> {
	const [raw, head, recentSubjects] = await Promise.all([
		git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root }),
		git.run(["rev-parse", "--verify", "HEAD"], { cwd: root, optional: true }),
		git.run(["log", "-12", "--pretty=format:%s"], { cwd: root, optional: true }),
	]);
	const files = parsePorcelainV2Z(raw);
	return {
		recentSubjects,
		intent: collectIntent(entries, markerType),
		files: await collectFileEvidence(git, root, files, Boolean(head)),
	};
}

export async function computeWorktreeSignature(
	git: GitRunner,
	root: string,
	files: readonly DirtyFile[],
): Promise<string> {
	const hash = createHash("sha256");
	const [status, stagedDiff, unstagedDiff] = await Promise.all([
		git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root }),
		git.run(["diff", "--cached", "--no-color", "--no-ext-diff"], { cwd: root, optional: true }),
		git.run(["diff", "--no-color", "--no-ext-diff"], { cwd: root, optional: true }),
	]);
	hash.update(status);
	hash.update("\0staged\0");
	hash.update(stagedDiff);
	hash.update("\0unstaged\0");
	hash.update(unstagedDiff);

	for (const file of files.filter((item) => item.untracked)) await hashUntrackedFile(hash, root, file.path);
	return hash.digest("hex");
}

export async function stageFilesOnly(git: GitRunner, root: string, files: readonly DirtyFile[]): Promise<void> {
	await git.run(["reset", "--mixed", "--quiet"], { cwd: root });
	const paths = files.flatMap((file) => (file.renamedFrom ? [file.renamedFrom, file.path] : [file.path]));
	if (paths.length > 0) await git.run(["add", "--", ...paths], { cwd: root });
}

export async function commitStaged(git: GitRunner, root: string, message: string): Promise<string> {
	const messageFile = join(tmpdir(), `pi-commit-${randomUUID()}.txt`);
	try {
		await writeFile(messageFile, `${message}\n`, "utf8");
		await git.run(["commit", "-F", messageFile], { cwd: root, timeout: COMMIT_TIMEOUT_MS });
		return await git.run(["rev-parse", "--short", "HEAD"], { cwd: root });
	} finally {
		await rm(messageFile, { force: true });
	}
}

export function assertCommittableState(files: readonly DirtyFile[]): void {
	const deletedStagedAdds = files.filter((file) => file.status === "AD").map((file) => file.path);
	if (deletedStagedAdds.length === 0) return;
	throw new Error(
		[
			"Staged additions were deleted from the working tree.",
			"Unstage or restore them before /commit:",
			...deletedStagedAdds.map((path) => `- ${path}`),
		].join("\n"),
	);
}

async function collectFileEvidence(
	git: GitRunner,
	root: string,
	files: readonly DirtyFile[],
	hasHead: boolean,
): Promise<DirtyFile[]> {
	const withEvidence: DirtyFile[] = [];
	for (let index = 0; index < files.length; index += EVIDENCE_CONCURRENCY) {
		withEvidence.push(
			...(await Promise.all(
				files
					.slice(index, index + EVIDENCE_CONCURRENCY)
					.map(async (file) => ({ ...file, evidence: await loadEvidenceForFile(git, root, file, hasHead) })),
			)),
		);
	}
	return withEvidence;
}

function parsePorcelainV2Z(raw: string): DirtyFile[] {
	if (!raw) return [];
	const parts = raw.split("\0").filter(Boolean);
	const parsed: ParsedDirtyFile[] = [];

	for (let index = 0; index < parts.length; index++) {
		const entry = parts[index];
		if (!entry) continue;
		if (entry[0] === "u") throw new Error("Unmerged conflict entries detected; resolve conflicts before committing.");
		if (entry[0] === "?") {
			parsed.push({ path: entry.slice(2), status: "??", untracked: true });
			continue;
		}

		const fields = entry.split(" ");
		if (entry[0] === "1")
			parsed.push({ path: fields.slice(8).join(" "), status: statusText(fields), untracked: false });
		if (entry[0] === "2") {
			const renamedFrom = parts[index + 1];
			parsed.push({
				path: fields.slice(9).join(" "),
				status: statusText(fields),
				untracked: false,
				...(renamedFrom ? { renamedFrom } : {}),
			});
			index++;
		}
	}

	return parsed
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((file, index) => ({ ...file, id: index + 1, kind: changeKind(file), evidence: "" }));
}

function statusText(fields: readonly string[]): string {
	return (fields[1] ?? "  ").replace(/\./g, " ");
}

async function loadEvidenceForFile(git: GitRunner, root: string, file: DirtyFile, hasHead: boolean): Promise<string> {
	if (file.untracked) return untrackedEvidence(root, file.path);
	if (file.kind === "deleted") return "deleted file; contents omitted";
	if (file.renamedFrom && !/[MAD]/.test(file.status)) return "renamed file; contents unchanged";

	const paths = file.renamedFrom ? [file.renamedFrom, file.path] : [file.path];
	if (!hasHead) return diffFromIndexAndWorktree(git, root, paths);
	const diff = await git.run(["diff", "--stat", "--patch", "--no-color", "--no-ext-diff", "HEAD", "--", ...paths], {
		cwd: root,
		optional: true,
	});
	return truncAt(diff || "metadata-only change", MAX_FILE_EVIDENCE_CHARS);
}

async function diffFromIndexAndWorktree(git: GitRunner, root: string, paths: readonly string[]): Promise<string> {
	const [staged, unstaged] = await Promise.all([
		git.run(["diff", "--cached", "--stat", "--patch", "--no-color", "--no-ext-diff", "--", ...paths], {
			cwd: root,
			optional: true,
		}),
		git.run(["diff", "--stat", "--patch", "--no-color", "--no-ext-diff", "--", ...paths], {
			cwd: root,
			optional: true,
		}),
	]);
	return truncAt(
		[staged && `staged diff:\n${staged}`, unstaged && `unstaged diff:\n${unstaged}`].filter(Boolean).join("\n\n") ||
			"metadata-only change",
		MAX_FILE_EVIDENCE_CHARS,
	);
}

async function untrackedEvidence(root: string, path: string): Promise<string> {
	try {
		const fullPath = join(root, path);
		const info = await stat(fullPath);
		if (!info.isFile()) return `untracked ${info.isDirectory() ? "directory" : "non-file"}`;
		if (info.size > MAX_UNTRACKED_PREVIEW_BYTES) return `untracked file, ${info.size} bytes`;
		const bytes = await readFile(fullPath);
		if (bytes.includes(0)) return `untracked binary file, ${info.size} bytes`;
		return truncAt(`untracked file preview:\n${bytes.toString("utf8")}`, MAX_FILE_EVIDENCE_CHARS);
	} catch (error) {
		return `untracked file preview unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function hashUntrackedFile(hash: ReturnType<typeof createHash>, root: string, path: string): Promise<void> {
	const fullPath = join(root, path);
	try {
		const info = await stat(fullPath);
		hash.update(`\0${path}:${info.size}:${info.mtimeMs}`);
		if (info.isFile() && info.size <= MAX_UNTRACKED_PREVIEW_BYTES) hash.update(await readFile(fullPath));
	} catch {
		hash.update(`\0${path}:missing`);
	}
}

function changeKind(file: ParsedDirtyFile): DirtyFile["kind"] {
	if (file.untracked) return "untracked";
	if (file.renamedFrom) return "renamed";
	if (file.status.includes("D")) return "deleted";
	if (file.status.includes("A")) return "added";
	return "modified";
}

function collectIntent(entries: readonly SessionEntry[], markerType: string): string[] {
	let intent: string[] = [];
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === markerType) {
			intent = [];
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractUserText(entry.message.content).trim();
		if (text && !/^\/commit(?:\s|$)/.test(text)) intent.push(text);
	}
	return boundIntent(intent);
}

function boundIntent(intent: readonly string[]): string[] {
	const bounded: string[] = [];
	let used = 0;
	for (let index = intent.length - 1; index >= 0; index--) {
		const message = intent[index];
		if (!message) continue;
		const remaining = MAX_INTENT_CHARS - used;
		if (remaining <= 0) break;
		const clipped = message.length > remaining ? truncAt(message, remaining) : message;
		bounded.push(clipped);
		used += clipped.length;
	}
	return bounded.reverse();
}

function extractUserText(content: string | Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.flatMap((part) => {
			if (part.type === "text") return [part.text];
			if (part.type === "image") return ["[image omitted]"];
			return [];
		})
		.join("\n");
}
