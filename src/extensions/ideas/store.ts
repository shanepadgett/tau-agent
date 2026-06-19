import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveProjectRoot } from "../../shared/settings/paths.ts";

export interface Idea {
	id: string;
	text: string;
	createdAt: number;
}

const IDEAS_FILENAME = "ideas.jsonl";

// Per-repo, under the existing `.pi/tau/` config dir so the file is resolved
// from the project root (stable regardless of the cwd pi was launched from)
// and lives alongside tau settings. Rough ideas stay out of docs/plans.
export async function ideasFilePath(cwd: string): Promise<string> {
	const root = await resolveProjectRoot(cwd);
	return join(root, ".pi", "tau", IDEAS_FILENAME);
}

export async function loadIdeas(cwd: string): Promise<Idea[]> {
	const path = await ideasFilePath(cwd);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return [];
		throw error;
	}

	return sortByNewest(parseIdeas(raw, path));
}

export async function addIdea(cwd: string, text: string): Promise<Idea> {
	const path = await ideasFilePath(cwd);
	const idea: Idea = { id: randomUUID(), text: text.trim(), createdAt: Date.now() };
	await mkdir(dirname(path), { recursive: true });
	await loadIdeas(cwd);
	await appendFile(path, `${JSON.stringify(idea)}\n`, "utf8");
	return idea;
}

export async function updateIdea(cwd: string, id: string, text: string): Promise<Idea[]> {
	const ideas = await loadIdeas(cwd);
	const next = ideas.map((idea) => (idea.id === id ? { ...idea, text: text.trim() } : idea));
	await saveIdeas(cwd, next);
	return next;
}

export async function deleteIdea(cwd: string, id: string): Promise<Idea[]> {
	const ideas = await loadIdeas(cwd);
	const next = ideas.filter((idea) => idea.id !== id);
	await saveIdeas(cwd, next);
	return next;
}

// Atomic rewrite for edit/delete: temp file in the same dir, then rename over the target.
// Keep the on-disk order matching display.
async function saveIdeas(cwd: string, ideas: readonly Idea[]): Promise<void> {
	const path = await ideasFilePath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const content = sortByNewest([...ideas])
		.map((idea) => JSON.stringify(idea))
		.join("\n");
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, content ? `${content}\n` : "", "utf8");
	await rename(tmp, path);
}

function sortByNewest(ideas: readonly Idea[]): Idea[] {
	return [...ideas].sort((left, right) => right.createdAt - left.createdAt);
}

function parseIdeas(raw: string, path: string): Idea[] {
	const ideas: Idea[] = [];
	let lineNumber = 0;
	for (const line of raw.split("\n")) {
		lineNumber++;
		const trimmed = line.trim();
		if (!trimmed) continue;
		ideas.push(parseIdea(trimmed, path, lineNumber));
	}
	return ideas;
}

function parseIdea(line: string, path: string, lineNumber: number): Idea {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error(`Invalid ideas JSONL at ${path}:${lineNumber}: ${errorText(error)}`);
	}
	if (!value || typeof value !== "object") throw invalidIdea(path, lineNumber);
	const record = value as Record<string, unknown>;
	const { id, text, createdAt } = record;
	if (typeof id !== "string" || typeof text !== "string" || typeof createdAt !== "number") {
		throw invalidIdea(path, lineNumber);
	}
	if (!Number.isFinite(createdAt)) throw invalidIdea(path, lineNumber);
	return { id, text, createdAt };
}

function invalidIdea(path: string, lineNumber: number): Error {
	return new Error(`Invalid idea record at ${path}:${lineNumber}`);
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
