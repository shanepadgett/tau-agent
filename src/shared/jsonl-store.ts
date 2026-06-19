import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveProjectRoot } from "./settings/paths.ts";

// Shared storage for per-repo JSONL lists of `{ id, text, createdAt }` records.
// Backs `ideas` and `stash`; both differ only in filename, error label, and the
// mutation semantics that live in their own modules.

export interface DatedRecord {
	id: string;
	text: string;
	createdAt: number;
}

// Per-repo, under `.pi/tau/` so the file is resolved from the project root
// (stable regardless of the cwd pi was launched from) and lives alongside tau
// settings.
export async function recordFilePath(cwd: string, filename: string): Promise<string> {
	const root = await resolveProjectRoot(cwd);
	return join(root, ".pi", "tau", filename);
}

export async function loadRecords(cwd: string, filename: string, label: string): Promise<DatedRecord[]> {
	const path = await recordFilePath(cwd, filename);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return [];
		throw error;
	}

	return sortByNewest(parseRecords(raw, path, label));
}

export async function appendRecord(cwd: string, filename: string, text: string): Promise<DatedRecord> {
	const path = await recordFilePath(cwd, filename);
	const record: DatedRecord = { id: randomUUID(), text: text.trim(), createdAt: Date.now() };
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
	return record;
}

// Atomic rewrite for edits/removals: temp file in the same dir, then rename
// over the target. Keeps on-disk order matching display (newest first).
export async function saveRecords(cwd: string, filename: string, records: readonly DatedRecord[]): Promise<void> {
	const path = await recordFilePath(cwd, filename);
	await mkdir(dirname(path), { recursive: true });
	const content = sortByNewest([...records])
		.map((record) => JSON.stringify(record))
		.join("\n");
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, content ? `${content}\n` : "", "utf8");
	await rename(tmp, path);
}

function sortByNewest(records: readonly DatedRecord[]): DatedRecord[] {
	return [...records].sort((left, right) => right.createdAt - left.createdAt);
}

function parseRecords(raw: string, path: string, label: string): DatedRecord[] {
	const records: DatedRecord[] = [];
	let lineNumber = 0;
	for (const line of raw.split("\n")) {
		lineNumber++;
		const trimmed = line.trim();
		if (!trimmed) continue;
		records.push(parseRecord(trimmed, path, lineNumber, label));
	}
	return records;
}

function parseRecord(line: string, path: string, lineNumber: number, label: string): DatedRecord {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error(`Invalid ${label} JSONL at ${path}:${lineNumber}: ${errorText(error)}`);
	}
	if (!value || typeof value !== "object") throw invalidRecord(path, lineNumber, label);
	const record = value as Record<string, unknown>;
	const { id, text, createdAt } = record;
	if (typeof id !== "string" || typeof text !== "string" || typeof createdAt !== "number") {
		throw invalidRecord(path, lineNumber, label);
	}
	if (!Number.isFinite(createdAt)) throw invalidRecord(path, lineNumber, label);
	return { id, text, createdAt };
}

function invalidRecord(path: string, lineNumber: number, label: string): Error {
	return new Error(`Invalid ${label} record at ${path}:${lineNumber}`);
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
