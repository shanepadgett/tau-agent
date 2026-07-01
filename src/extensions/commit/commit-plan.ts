import { randomUUID } from "node:crypto";
import { type ThinkingLevel, type Tool, Type } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { generateToolValidated, generateValidated, resolveCandidates } from "../../shared/model-fallback/index.ts";
import { truncAt } from "../../shared/text.ts";
import type { CommitEvidence, DirtyFile } from "./git-change-set.ts";

const MAX_PLAN_EVIDENCE_CHARS = 48_000;
const CONVENTIONAL_COMMIT_TYPES = ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "ci", "build", "revert"];
const COMMIT_MODELS: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> = [
	{ provider: "openai-codex", model: "gpt-5.5", reasoning: "low" },
];
const COMMIT_PLAN_TOOL = {
	name: "create_commit_plan",
	description: "Submit the commit plan for the dirty repository files.",
	parameters: Type.Object({
		commits: Type.Array(
			Type.Object({
				message: Type.String({ description: "Git commit message." }),
				allFiles: Type.Boolean({ description: "True only for a single commit that includes every dirty file." }),
				files: Type.Array(Type.Integer({ description: "Numeric dirty file ID. Empty when allFiles is true." })),
			}),
		),
	}),
} satisfies Tool;

export interface CommitGroup {
	id: string;
	message: string;
	files: string[];
}

export interface CommitPlanState {
	files: readonly DirtyFile[];
	groups: CommitGroup[];
	worktreeSignature: string;
}

interface CommitPlanToolInput {
	commits: readonly CommitPlanToolCommit[];
}

interface CommitPlanToolCommit {
	message: string;
	allFiles: boolean;
	files: readonly number[];
}

export async function generatePlan(
	ctx: ExtensionCommandContext,
	evidence: CommitEvidence,
	previousPlan: readonly CommitGroup[] = [],
	regenerationNote = "",
): Promise<CommitGroup[]> {
	const prompt = buildPlanPrompt(evidence, previousPlan, regenerationNote);
	return generateToolValidated(
		ctx,
		await resolveCandidates(ctx, COMMIT_MODELS),
		prompt,
		COMMIT_PLAN_TOOL,
		(input) => commitGroupsFromToolInput(input, evidence.files),
		(error, text) =>
			[
				`That commit plan failed validation: ${error.message}`,
				`Call ${COMMIT_PLAN_TOOL.name} again with corrected arguments only.`,
				"Use only numeric file IDs provided in the prompt.",
				"Include every dirty file ID exactly once across the plan.",
				"Set allFiles true only for a single all-files commit; then set files to an empty array.",
				"Previous response:",
				text,
			].join("\n"),
		{ statusKey: "commit", notifyOnFallback: true },
	);
}

export async function regenerateMessage(
	ctx: ExtensionCommandContext,
	evidence: CommitEvidence,
	files: readonly string[],
	previousPlan: readonly CommitGroup[] = [],
	selectedGroupId: string | undefined = undefined,
	regenerationNote = "",
): Promise<string> {
	const selected = evidence.files.filter((file) => files.includes(file.path));
	const prompt = buildMessagePrompt(evidence, selected, previousPlan, selectedGroupId, regenerationNote);
	return generateValidated(ctx, await resolveCandidates(ctx, COMMIT_MODELS), prompt, requireCommitMessage, undefined, {
		statusKey: "commit",
		notifyOnFallback: true,
	});
}

export function requireCommitMessage(rawMessage: string): string {
	const message = stripCodeFence(rawMessage)
		.replace(/^commit message:\s*/i, "")
		.trim()
		.replace(/\r\n/g, "\n");
	if (!message) throw new Error("Commit message is empty.");

	const [subject, ...bodyLines] = message.split("\n");
	if (!subject) throw new Error("Commit message subject is empty.");
	const match = subject.match(
		/^(feat|fix|docs|refactor|test|chore|perf|ci|build|revert)(\([a-z0-9]+(?:-[a-z0-9]+)*\))?(!)?: .+$/,
	);
	if (!match) throw new Error("Commit subject must be a valid conventional commit message.");

	const body = bodyLines.join("\n");
	if (!match[3]) {
		if (body) throw new Error("Non-breaking commit messages must not have a body.");
		return message;
	}
	if (!body.startsWith("\nBREAKING CHANGE:")) {
		throw new Error("Breaking commit messages need one body paragraph starting with BREAKING CHANGE:.");
	}
	if (body.slice(1).includes("\n\n"))
		throw new Error("Breaking commit messages must have exactly one body paragraph.");
	return message;
}

function commitGroupsFromToolInput(input: unknown, files: readonly DirtyFile[]): CommitGroup[] {
	if (!isCommitPlanToolInput(input)) throw new Error("Commit plan tool input is malformed.");
	const pathById = new Map(files.map((file) => [file.id, file.path]));
	const seen = new Set<string>();
	const groups = input.commits.flatMap((commit) =>
		groupFromToolCommit(commit, input.commits.length, files, pathById, seen),
	);
	if (groups.length === 0) throw new Error("Commit plan produced no non-empty commits.");
	assertAllFilesAssigned(files, seen);
	return groups;
}

function groupFromToolCommit(
	commit: CommitPlanToolCommit,
	commitCount: number,
	files: readonly DirtyFile[],
	pathById: ReadonlyMap<number, string>,
	seen: Set<string>,
): CommitGroup[] {
	const paths = commit.allFiles
		? allFilesForSingleCommit(commitCount, files, seen)
		: listedFiles(commit.files, pathById, seen);
	return paths.length > 0 ? [{ id: randomUUID(), message: requireCommitMessage(commit.message), files: paths }] : [];
}

function allFilesForSingleCommit(commitCount: number, files: readonly DirtyFile[], seen: Set<string>): string[] {
	if (commitCount !== 1) throw new Error("allFiles is only valid for a single-commit plan.");
	const paths = files.map((file) => file.path);
	for (const path of paths) seen.add(path);
	return paths;
}

function listedFiles(ids: readonly number[], pathById: ReadonlyMap<number, string>, seen: Set<string>): string[] {
	const paths: string[] = [];
	for (const id of ids) {
		const path = pathById.get(id);
		if (!path) throw new Error(`Unknown dirty file ID in commit plan: ${id}`);
		if (seen.has(path)) throw new Error(`Dirty file ID is used more than once in commit plan: ${id}`);
		seen.add(path);
		paths.push(path);
	}
	return paths;
}

function assertAllFilesAssigned(files: readonly DirtyFile[], seen: ReadonlySet<string>): void {
	const missing = files.filter((file) => !seen.has(file.path));
	if (missing.length === 0) return;
	throw new Error(`Commit plan omitted dirty file IDs: ${missing.map((file) => file.id).join(", ")}`);
}

function buildPlanPrompt(
	evidence: CommitEvidence,
	previousPlan: readonly CommitGroup[],
	regenerationNote: string,
): string {
	return [
		"Create the fewest useful commits for the dirty repository files.",
		`You have exactly one job: call ${COMMIT_PLAN_TOOL.name} once with the final plan.`,
		"Do not answer in text. Do not explain. Do not include markdown.",
		`Any response except a single ${COMMIT_PLAN_TOOL.name} tool call is invalid.`,
		"File references must be numeric IDs only, never paths.",
		"Every dirty file ID from the File catalog must appear in exactly one commit.",
		"If any dirty file ID is missing from the plan, validation fails.",
		"Tool argument shape:",
		"commits: [{ message: string, allFiles: boolean, files: number[] }]",
		"For one commit containing all dirty files: { message, allFiles: true, files: [] }",
		"Otherwise: { message, allFiles: false, files: [numeric IDs from File catalog] }",
		"Commit ladder:",
		"1. Can all dirty files be committed together with one honest conventional commit message a user would understand?",
		"   If yes, return one commit.",
		"2. For one all-files commit, set allFiles true and files to an empty array instead of listing every ID.",
		"3. If one message would be misleading, split off only files with a clearly different purpose.",
		"4. Keep README/docs/tests/prompts/UI text with the code change they describe or verify.",
		"5. Do not split by file type, directory, or conventional commit type alone.",
		"6. Every dirty file must belong to one of the commits.",
		"7. Use the minimum number of commits that preserves meaning.",
		"Rules:",
		"- Prefer fewer coherent commits over tidy-looking categories.",
		"- Use each dirty file exactly once.",
		"- Use only numeric file IDs listed below.",
		"- Prefer conventional commit messages.",
		`- Allowed conventional commit types: ${CONVENTIONAL_COMMIT_TYPES.join(", ")}.`,
		"- Optional scope must be lowercase kebab-case, singular, and useful; omit it for broad or unrelated changes.",
		"- Subject must be one concise imperative line, no trailing period, max 100 characters.",
		"- Prefer exactly one line for non-breaking changes.",
		"- For breaking changes, prefer ! plus one body paragraph starting with BREAKING CHANGE:.",
		"Recent commit subjects are style guidance. User intent explains why. File evidence is authoritative.",
		"When regenerating, use the previous plan and user note to understand what to change; do not copy mistakes.",
		"",
		"Recent commit subjects:",
		evidence.recentSubjects || "(none)",
		"",
		"User intent since last commit:",
		formatIntent(evidence.intent),
		"",
		...formatRegenerationContext(evidence.files, previousPlan, undefined, regenerationNote),
		"File catalog:",
		formatFileCatalog(evidence.files),
		"",
		"File evidence:",
		truncAt(evidence.files.map(formatFileEvidence).join("\n\n"), MAX_PLAN_EVIDENCE_CHARS),
	].join("\n");
}

function buildMessagePrompt(
	evidence: CommitEvidence,
	files: readonly DirtyFile[],
	previousPlan: readonly CommitGroup[],
	selectedGroupId: string | undefined,
	regenerationNote: string,
): string {
	return [
		"Write one git commit message for the selected dirty files.",
		"Prefer this conventional commit format:",
		"<type>[optional scope][!]: <description>",
		`Allowed conventional commit types: ${CONVENTIONAL_COMMIT_TYPES.join(", ")}.`,
		"Prefer lowercase kebab-case scopes only when useful; omit for broad or unrelated changes.",
		"For non-breaking changes, output one subject line and no body.",
		"For breaking changes, use ! plus one body paragraph starting with BREAKING CHANGE:.",
		"Do not wrap the message in markdown or code fences.",
		"",
		"Recent commit subjects:",
		evidence.recentSubjects || "(none)",
		"",
		"User intent since last commit:",
		formatIntent(evidence.intent),
		"",
		...formatRegenerationContext(evidence.files, previousPlan, selectedGroupId, regenerationNote),
		"Selected files:",
		truncAt(files.map(formatFileEvidence).join("\n\n"), MAX_PLAN_EVIDENCE_CHARS),
	].join("\n");
}

function formatFileCatalog(files: readonly DirtyFile[]): string {
	const groups = new Map<string, string[]>();
	for (const file of files) {
		const slash = file.path.lastIndexOf("/");
		const folder = slash >= 0 ? `${file.path.slice(0, slash)}/` : "./";
		const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
		const lines = groups.get(folder) ?? [];
		lines.push(`  [${file.id}] ${file.status} ${name}${file.renamedFrom ? ` ← ${file.renamedFrom}` : ""}`);
		groups.set(folder, lines);
	}
	return [...groups.entries()].map(([folder, lines]) => [folder, ...lines].join("\n")).join("\n");
}

function formatFileEvidence(file: DirtyFile): string {
	return [
		`[${file.id}] ${file.status} ${file.path}`,
		file.renamedFrom && `Renamed from: ${file.renamedFrom}`,
		`Kind: ${file.kind}`,
		file.evidence,
	]
		.filter(Boolean)
		.join("\n");
}

function formatIntent(intent: readonly string[]): string {
	return intent.length > 0 ? intent.map((message, index) => `[${index + 1}]\n${message}`).join("\n\n") : "(none)";
}

function formatRegenerationContext(
	files: readonly DirtyFile[],
	previousPlan: readonly CommitGroup[],
	selectedGroupId: string | undefined,
	regenerationNote: string,
): string[] {
	if (previousPlan.length === 0 && !regenerationNote.trim()) return [];
	const idByPath = new Map(files.map((file) => [file.path, file.id]));
	return [
		"Previous commit plan:",
		previousPlan.length > 0
			? previousPlan
					.map((group, index) => {
						const selected = group.id === selectedGroupId ? " (selected)" : "";
						const groupFiles = group.files.map((file) => `- [${idByPath.get(file) ?? "?"}] ${file}`).join("\n");
						return `[${index + 1}]${selected}\nMessage: ${group.message}\nFiles:\n${groupFiles}`;
					})
					.join("\n\n")
			: "(none)",
		"",
		"User regeneration note:",
		regenerationNote.trim() || "(none)",
		"",
	];
}

function stripCodeFence(raw: string): string {
	const text = raw.trim();
	const fenced = text.match(/^```(?:gitcommit|json|text)?\s*\n([\s\S]*?)\n```$/i);
	return fenced?.[1]?.trim() ?? text;
}

function isCommitPlanToolInput(value: unknown): value is CommitPlanToolInput {
	return isRecord(value) && Array.isArray(value.commits) && value.commits.every(isCommitPlanToolCommit);
}

function isCommitPlanToolCommit(value: unknown): value is CommitPlanToolCommit {
	return (
		isRecord(value) &&
		typeof value.message === "string" &&
		typeof value.allFiles === "boolean" &&
		Array.isArray(value.files) &&
		value.files.every((file) => typeof file === "number" && Number.isInteger(file))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
