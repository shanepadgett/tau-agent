import { appendRecord, type DatedRecord, loadRecords, recordFilePath, saveRecords } from "../../shared/jsonl-store.ts";

export type Stash = DatedRecord;

const STASH_FILENAME = "stash.jsonl";
const LABEL = "stash";

export function stashFilePath(cwd: string): Promise<string> {
	return recordFilePath(cwd, STASH_FILENAME);
}

export function loadStashes(cwd: string): Promise<Stash[]> {
	return loadRecords(cwd, STASH_FILENAME, LABEL);
}

// Returns null when identical text already exists (dedupe), so callers can
// report a no-op without polluting the list with duplicates.
export async function addStash(cwd: string, text: string): Promise<Stash | null> {
	const trimmed = text.trim();
	if ((await loadStashes(cwd)).some((stash) => stash.text === trimmed)) return null;
	return appendRecord(cwd, STASH_FILENAME, trimmed);
}

export async function removeStash(cwd: string, id: string): Promise<Stash[]> {
	const stashes = await loadStashes(cwd);
	const next = stashes.filter((stash) => stash.id !== id);
	await saveRecords(cwd, STASH_FILENAME, next);
	return next;
}
