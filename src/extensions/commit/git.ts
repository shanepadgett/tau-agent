import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "../../shared/git.ts";
import { truncAt } from "../../shared/text.ts";
import type { DirtyFile } from "./types.ts";

const COMMIT_TIMEOUT_MS = 120_000;
const MAX_FILE_EVIDENCE_CHARS = 6_000;
const MAX_UNTRACKED_PREVIEW_BYTES = 12_000;

export async function loadDirtyFiles(git: GitRunner, cwd: string): Promise<DirtyFile[]> {
	const raw = await git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd });
	return parsePorcelainV2Z(raw).map((file) => ({ ...file, evidence: "" }));
}

export async function collectFileEvidence(
	git: GitRunner,
	cwd: string,
	files: readonly DirtyFile[],
): Promise<DirtyFile[]> {
	const withEvidence: DirtyFile[] = [];
	for (const file of files) {
		withEvidence.push({ ...file, evidence: await loadEvidenceForFile(git, cwd, file) });
	}
	return withEvidence;
}

export async function computeWorktreeSignature(
	git: GitRunner,
	cwd: string,
	files: readonly DirtyFile[],
): Promise<string> {
	const hash = createHash("sha256");
	const [status, stagedDiff, unstagedDiff] = await Promise.all([
		git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd }),
		git.run(["diff", "--cached", "--no-color", "--no-ext-diff"], { cwd, optional: true }),
		git.run(["diff", "--no-color", "--no-ext-diff"], { cwd, optional: true }),
	]);
	hash.update(status);
	hash.update("\0staged\0");
	hash.update(stagedDiff);
	hash.update("\0unstaged\0");
	hash.update(unstagedDiff);
	for (const file of files.filter((item) => item.untracked)) {
		try {
			const info = await stat(join(cwd, file.path));
			hash.update(`\0${file.path}:${info.size}:${info.mtimeMs}`);
			if (info.isFile() && info.size <= MAX_UNTRACKED_PREVIEW_BYTES) {
				hash.update(await readFile(join(cwd, file.path)));
			}
		} catch {
			hash.update(`\0${file.path}:missing`);
		}
	}
	return hash.digest("hex");
}

export async function stageFilesOnly(git: GitRunner, cwd: string, files: readonly DirtyFile[]): Promise<void> {
	await git.run(["reset", "--mixed", "--quiet"], { cwd });
	const stagePaths = files.flatMap((file) => (file.renamedFrom ? [file.renamedFrom, file.path] : [file.path]));
	if (stagePaths.length === 0) return;
	await git.run(["add", "--", ...stagePaths], { cwd });
}

export async function commitStaged(git: GitRunner, cwd: string, message: string): Promise<string> {
	const messageFile = join(tmpdir(), `pi-commit-${randomUUID()}.txt`);
	try {
		await writeFile(messageFile, `${message}\n`, "utf8");
		await git.run(["commit", "-F", messageFile], { cwd, timeout: COMMIT_TIMEOUT_MS });
		return await git.run(["rev-parse", "--short", "HEAD"], { cwd });
	} finally {
		await rm(messageFile, { force: true });
	}
}

function parsePorcelainV2Z(raw: string): DirtyFile[] {
	if (!raw) return [];
	const parts = raw.split("\0").filter(Boolean);
	const files: DirtyFile[] = [];

	for (let index = 0; index < parts.length; index++) {
		const entry = parts[index]!;
		const kind = entry[0];
		if (kind === "u") {
			throw new Error("Unmerged conflict entries detected; resolve conflicts before committing.");
		}
		if (kind === "?") {
			files.push({
				path: entry.slice(2),
				status: "??",
				staged: false,
				unstaged: false,
				untracked: true,
				evidence: "",
			});
			continue;
		}

		if (kind === "1") {
			const fields = entry.split(" ");
			const status = (fields[1] ?? "  ").replace(/\./g, " ");
			files.push({
				path: fields.slice(8).join(" "),
				status,
				staged: status[0] !== " ",
				unstaged: status[1] !== " ",
				untracked: false,
				evidence: "",
			});
			continue;
		}

		if (kind === "2") {
			const fields = entry.split(" ");
			const status = (fields[1] ?? "  ").replace(/\./g, " ");
			files.push({
				path: fields.slice(9).join(" "),
				status,
				staged: status[0] !== " ",
				unstaged: status[1] !== " ",
				untracked: false,
				renamedFrom: parts[index + 1],
				evidence: "",
			});
			index++;
		}
	}

	return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function loadEvidenceForFile(git: GitRunner, cwd: string, file: DirtyFile): Promise<string> {
	const header = [`${file.status} ${file.path}`, file.renamedFrom ? `renamed from ${file.renamedFrom}` : ""]
		.filter(Boolean)
		.join("\n");

	if (file.untracked) {
		return `${header}\n${await untrackedEvidence(cwd, file.path)}`.trim();
	}

	const [staged, unstaged] = await Promise.all([
		git.run(["diff", "--cached", "--stat", "--patch", "--no-color", "--no-ext-diff", "--", file.path], {
			cwd,
			optional: true,
		}),
		git.run(["diff", "--stat", "--patch", "--no-color", "--no-ext-diff", "--", file.path], {
			cwd,
			optional: true,
		}),
	]);
	return truncAt(
		[header, staged && `staged diff:\n${staged}`, unstaged && `unstaged diff:\n${unstaged}`]
			.filter(Boolean)
			.join("\n\n"),
		MAX_FILE_EVIDENCE_CHARS,
	);
}

async function untrackedEvidence(cwd: string, path: string): Promise<string> {
	try {
		const fullPath = join(cwd, path);
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
