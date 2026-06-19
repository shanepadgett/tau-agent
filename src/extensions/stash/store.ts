import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveProjectRoot } from "../../shared/settings/paths.ts";

export interface Stash {
	id: string;
	text: string;
	createdAt: number;
}

const STASH_FILENAME = "stash.jsonl";

// Per-repo, under the existing `.pi/tau/` config dir so the file is resolved
// from the project root (stable regardless of the cwd pi was launched from)
// and lives alongside tau settings. Stashed prompts stay out of docs/plans.
export async function stashFilePath(cwd: string): Promise<string> {
	const root = await resolveProjectRoot(cwd);
	return join(root, ".pi", "tau", STASH_FILENAME);
}

export async function loadStashes(cwd: string): Promise<Stash[]> {
	const path = await stashFilePath(cwd);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return [];
		throw error;
	}

	return sortByNewest(parseStashes(raw, path));
}

// Returns null when an identical stash already exists (dedupe), so callers can
// report a no-op without polluting the list with duplicates.
export async function addStash(cwd: string, text: string): Promise<Stash | null> {
	const path = await stashFilePath(cwd);
	const trimmed = text.trim();
	const existing = await loadStashes(cwd);
	if (existing.some((stash) => stash.text === trimmed)) return null;

	const stash: Stash = { id: randomUUID(), text: trimmed, createdAt: Date.now() };
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(stash)}\n`, "utf8");
	return stash;
}

export async function removeStash(cwd: string, id: string): Promise<Stash[]> {
	const stashes = await loadStashes(cwd);
	const next = stashes.filter((stash) => stash.id !== id);
	await saveStashes(cwd, next);
	return next;
}

// Atomic rewrite for removal: temp file in the same dir, then rename over the
// target. Keep the on-disk order matching display.
async function saveStashes(cwd: string, stashes: readonly Stash[]): Promise<void> {
	const path = await stashFilePath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const content = sortByNewest([...stashes])
		.map((stash) => JSON.stringify(stash))
		.join("\n");
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, content ? `${content}\n` : "", "utf8");
	await rename(tmp, path);
}

function sortByNewest(stashes: readonly Stash[]): Stash[] {
	return [...stashes].sort((left, right) => right.createdAt - left.createdAt);
}

function parseStashes(raw: string, path: string): Stash[] {
	const stashes: Stash[] = [];
	let lineNumber = 0;
	for (const line of raw.split("\n")) {
		lineNumber++;
		const trimmed = line.trim();
		if (!trimmed) continue;
		stashes.push(parseStash(trimmed, path, lineNumber));
	}
	return stashes;
}

function parseStash(line: string, path: string, lineNumber: number): Stash {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error(`Invalid stash JSONL at ${path}:${lineNumber}: ${errorText(error)}`);
	}
	if (!value || typeof value !== "object") throw invalidStash(path, lineNumber);
	const record = value as Record<string, unknown>;
	const { id, text, createdAt } = record;
	if (typeof id !== "string" || typeof text !== "string" || typeof createdAt !== "number") {
		throw invalidStash(path, lineNumber);
	}
	if (!Number.isFinite(createdAt)) throw invalidStash(path, lineNumber);
	return { id, text, createdAt };
}

function invalidStash(path: string, lineNumber: number): Error {
	return new Error(`Invalid stash record at ${path}:${lineNumber}`);
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
