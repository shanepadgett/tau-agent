import { homedir } from "node:os";
import { join } from "node:path";
import {
	appendRecordAtPath,
	loadRecordsAtPath,
	saveRecordsAtPath,
	type DatedRecord,
} from "../../shared/jsonl-store.ts";

export type Stash = DatedRecord;

const STASH_FILENAME = "stash.jsonl";
const LABEL = "stash";

export function stashFilePath(_cwd: string): Promise<string> {
	return Promise.resolve(join(homedir(), ".pi", "tau", STASH_FILENAME));
}

export async function loadStashes(cwd: string): Promise<Stash[]> {
	return loadRecordsAtPath(await stashFilePath(cwd), LABEL);
}

// Returns null when identical text already exists (dedupe), so callers can
// report a no-op without polluting the list with duplicates.
export async function addStash(cwd: string, text: string): Promise<Stash | null> {
	const trimmed = text.trim();
	if ((await loadStashes(cwd)).some((stash) => stash.text === trimmed)) return null;
	return appendRecordAtPath(await stashFilePath(cwd), trimmed);
}

export async function removeStash(cwd: string, id: string): Promise<Stash[]> {
	const stashes = await loadStashes(cwd);
	const next = stashes.filter((stash) => stash.id !== id);
	await saveRecordsAtPath(await stashFilePath(cwd), next);
	return next;
}
