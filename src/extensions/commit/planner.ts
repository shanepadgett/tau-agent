import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { generateValidated } from "../../shared/model-fallback/index.ts";
import type { ModelCandidate } from "../../shared/model-fallback/types.ts";
import { errorText, truncAt } from "../../shared/text.ts";
import { cleanMessage, stripCodeFence, validateMessage } from "./message.ts";
import type { CommitEvidence, CommitPlanGroup, DirtyFile } from "./types.ts";

const MAX_PLAN_EVIDENCE_CHARS = 70_000;

interface RawPlan {
	commits?: unknown;
}

interface RawGroup {
	message?: unknown;
	files?: unknown;
	rationale?: unknown;
}

export async function generateInitialPlan(
	ctx: ExtensionCommandContext,
	candidates: readonly ModelCandidate[],
	evidence: CommitEvidence,
): Promise<CommitPlanGroup[]> {
	return generateValidated(
		ctx,
		candidates,
		buildPlanPrompt(evidence),
		(text) => validatePlanResponse(text, evidence.files),
		(error, text) =>
			[
				`That commit plan failed validation: ${error.message}`,
				"Return corrected JSON only.",
				'Use only dirty file paths provided in the prompt, or files: "ALL" for a single all-files commit.',
				"Every message must be a valid conventional commit message.",
				"Previous response:",
				text,
			].join("\n"),
		{ statusKey: "commit", notifyOnFallback: true },
	);
}

export async function regenerateGroupMessage(
	ctx: ExtensionCommandContext,
	candidates: readonly ModelCandidate[],
	evidence: CommitEvidence,
	files: readonly string[],
): Promise<string> {
	const selected = evidence.files.filter((file) => files.includes(file.path));
	return generateValidated(
		ctx,
		candidates,
		buildMessagePrompt(evidence, selected),
		(text) => validateMessage(cleanMessage(text)),
		(error, text) =>
			[
				`That commit message failed validation: ${error.message}`,
				"Return one corrected commit message only.",
				"If this is not a breaking change, return exactly one line with no body.",
				"Do not include explanations, markdown, or code fences.",
				"Previous response:",
				text,
			].join("\n"),
		{ statusKey: "commit", notifyOnFallback: true },
	);
}

function validatePlanResponse(raw: string, dirtyFiles: readonly DirtyFile[]): CommitPlanGroup[] {
	const text = stripCodeFence(raw);
	let parsed: RawPlan;
	try {
		parsed = JSON.parse(text) as RawPlan;
	} catch (error) {
		throw new Error(`Commit plan must be valid JSON: ${errorText(error)}`);
	}
	if (!Array.isArray(parsed.commits)) throw new Error("Commit plan JSON must contain a commits array.");

	const dirtyPaths = new Set(dirtyFiles.map((file) => file.path));
	const seen = new Set<string>();
	const groups: CommitPlanGroup[] = [];

	for (const value of parsed.commits) {
		const rawGroup = value as RawGroup;
		if (typeof rawGroup.message !== "string") throw new Error("Every commit must include a message string.");

		let files: string[];
		if (rawGroup.files === "ALL") {
			if (parsed.commits.length !== 1) throw new Error('files: "ALL" is only valid for a single-commit plan.');
			files = dirtyFiles.map((file) => file.path);
		} else {
			if (!Array.isArray(rawGroup.files)) throw new Error('Every commit must include a files array or "ALL".');
			files = [];
			for (const file of rawGroup.files) {
				if (typeof file !== "string") throw new Error("Commit file paths must be strings.");
				if (!dirtyPaths.has(file)) throw new Error(`Unknown dirty file in commit plan: ${file}`);
				if (seen.has(file)) continue;
				seen.add(file);
				files.push(file);
			}
		}
		if (files.length === 0) continue;

		groups.push({
			id: randomUUID(),
			message: validateMessage(cleanMessage(rawGroup.message)),
			files,
			rationale: typeof rawGroup.rationale === "string" ? rawGroup.rationale : undefined,
		});
	}

	if (groups.length === 0) throw new Error("Commit plan produced no non-empty commits.");
	return groups;
}

export function normalizePlan(groups: readonly CommitPlanGroup[], dirtyFiles: readonly DirtyFile[]): CommitPlanGroup[] {
	const dirtyPaths = new Set(dirtyFiles.map((file) => file.path));
	const seen = new Set<string>();
	const normalized: CommitPlanGroup[] = [];
	for (const group of groups) {
		const files = group.files.filter((file) => {
			if (!dirtyPaths.has(file) || seen.has(file)) return false;
			seen.add(file);
			return true;
		});
		if (files.length === 0) continue;
		normalized.push({ ...group, message: validateMessage(group.message), files });
	}
	return normalized;
}

export function unassignedFiles(files: readonly DirtyFile[], groups: readonly CommitPlanGroup[]): DirtyFile[] {
	const assigned = new Set(groups.flatMap((group) => group.files));
	return files.filter((file) => !assigned.has(file.path));
}

export function assignFilesToGroup(
	groups: readonly CommitPlanGroup[],
	groupId: string,
	selectedFiles: readonly string[],
): CommitPlanGroup[] {
	const selected = new Set(selectedFiles);
	return groups.map((group) => {
		const otherGroupFiles = group.files.filter((file) => !selected.has(file));
		if (group.id !== groupId) return { ...group, files: otherGroupFiles };
		return { ...group, files: [...selected] };
	});
}

export function appendGroup(
	groups: readonly CommitPlanGroup[],
	message: string,
	files: readonly string[],
): CommitPlanGroup[] {
	const selected = new Set(files);
	return [
		...groups.map((group) => ({ ...group, files: group.files.filter((file) => !selected.has(file)) })),
		{ id: randomUUID(), message: validateMessage(message), files: [...files] },
	];
}

export function deleteGroup(groups: readonly CommitPlanGroup[], groupId: string): CommitPlanGroup[] {
	return groups.filter((group) => group.id !== groupId);
}

export function moveGroup(groups: readonly CommitPlanGroup[], groupId: string, direction: -1 | 1): CommitPlanGroup[] {
	const next = [...groups];
	const index = next.findIndex((group) => group.id === groupId);
	const target = index + direction;
	if (index < 0 || target < 0 || target >= next.length) return next;
	const [group] = next.splice(index, 1);
	if (!group) return next;
	next.splice(target, 0, group);
	return next;
}

export function updateGroupMessage(
	groups: readonly CommitPlanGroup[],
	groupId: string,
	message: string,
): CommitPlanGroup[] {
	return groups.map((group) => (group.id === groupId ? { ...group, message: validateMessage(message) } : group));
}

function buildPlanPrompt(evidence: CommitEvidence): string {
	return [
		"Create the fewest useful commits for the dirty repository files.",
		"Return strict JSON only, no markdown, in one of these shapes:",
		'{"commits":[{"message":"feat(scope): imperative subject","files":["path"],"rationale":"optional short reason"}]}',
		'{"commits":[{"message":"feat(scope): imperative subject","files":"ALL","rationale":"optional short reason"}]}',
		"Commit ladder:",
		"1. Can all dirty files be committed together with one honest conventional commit message a user would understand? If yes, return one commit.",
		'2. For one all-files commit, use files: "ALL" instead of listing every path.',
		"3. If one message would be misleading, split off only files with a clearly different purpose.",
		"4. Keep README/docs/tests/prompts/UI text with the code change they describe or verify.",
		"5. Do not split by file type, directory, or conventional commit type alone.",
		"6. Leave unrelated/random files out only when they do not belong to any coherent commit.",
		"7. Use the minimum number of commits that preserves meaning.",
		"Rules:",
		"- Prefer fewer coherent commits over tidy-looking categories.",
		"- Use each dirty file at most once.",
		'- Use only file paths listed below, except the sole-commit files: "ALL" shortcut.',
		"- Commit messages must use strict conventional commit format.",
		"- Allowed types: feat, fix, docs, refactor, test, chore, perf, ci, build, revert.",
		"- Optional scope must be lowercase kebab-case, singular, and useful; omit it for broad or unrelated changes.",
		"- Subject must be one concise imperative line, no trailing period, max 100 characters.",
		"- For non-breaking changes, message must be exactly one line.",
		"- For breaking changes, add ! and include one body paragraph starting with BREAKING CHANGE:.",
		"Recent commit subjects are style guidance. User intent explains why. File evidence is authoritative.",
		"",
		"Recent commit subjects:",
		evidence.recentSubjects || "(none)",
		"",
		"User intent since last commit:",
		formatIntent(evidence.intent),
		"",
		"Dirty files:",
		truncAt(evidence.files.map(formatFileEvidence).join("\n\n"), MAX_PLAN_EVIDENCE_CHARS),
	].join("\n");
}

function buildMessagePrompt(evidence: CommitEvidence, files: readonly DirtyFile[]): string {
	return [
		"Write one git commit message for the selected dirty files.",
		"Use this strict conventional commit format:",
		"<type>[optional scope][!]: <description>",
		"Allowed types: feat, fix, docs, refactor, test, chore, perf, ci, build, revert.",
		"Optional scope must be lowercase kebab-case, singular, and useful; omit it for broad or unrelated changes.",
		"Subject must be one concise imperative line, no trailing period, max 100 characters.",
		"For non-breaking changes, return exactly one line and no body.",
		"For breaking changes, add ! to the header and include exactly one body paragraph starting with BREAKING CHANGE:.",
		"Do not wrap the message in markdown or code fences.",
		"",
		"Recent commit subjects:",
		evidence.recentSubjects || "(none)",
		"",
		"User intent since last commit:",
		formatIntent(evidence.intent),
		"",
		"Selected files:",
		truncAt(files.map(formatFileEvidence).join("\n\n"), MAX_PLAN_EVIDENCE_CHARS),
	].join("\n");
}

function formatIntent(intent: readonly string[]): string {
	return intent.length > 0 ? intent.map((message, index) => `[${index + 1}]\n${message}`).join("\n\n") : "(none)";
}

function formatFileEvidence(file: DirtyFile): string {
	return [
		`File: ${file.path}`,
		`Status: ${file.status}`,
		file.renamedFrom && `Renamed from: ${file.renamedFrom}`,
		file.evidence,
	]
		.filter(Boolean)
		.join("\n");
}
