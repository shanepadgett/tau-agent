import { appendRecord, type DatedRecord, loadRecords, recordFilePath, saveRecords } from "../../shared/jsonl-store.ts";

export type Idea = DatedRecord;

const IDEAS_FILENAME = "ideas.jsonl";
const LABEL = "idea";

export function ideasFilePath(cwd: string): Promise<string> {
	return recordFilePath(cwd, IDEAS_FILENAME);
}

export function loadIdeas(cwd: string): Promise<Idea[]> {
	return loadRecords(cwd, IDEAS_FILENAME, LABEL);
}

export function addIdea(cwd: string, text: string): Promise<Idea> {
	return appendRecord(cwd, IDEAS_FILENAME, text);
}

export async function updateIdea(cwd: string, id: string, text: string): Promise<Idea[]> {
	const ideas = await loadIdeas(cwd);
	const next = ideas.map((idea) => (idea.id === id ? { ...idea, text: text.trim() } : idea));
	await saveRecords(cwd, IDEAS_FILENAME, next);
	return next;
}

export async function deleteIdea(cwd: string, id: string): Promise<Idea[]> {
	const ideas = await loadIdeas(cwd);
	const next = ideas.filter((idea) => idea.id !== id);
	await saveRecords(cwd, IDEAS_FILENAME, next);
	return next;
}
