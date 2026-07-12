import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { Type, type Tool } from "@earendil-works/pi-ai";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "smol-toml";
import { createGitRunner, loadRepoStatus, type GitRunner } from "../../shared/git.ts";
import { generateToolValidated, resolveCandidates } from "../../shared/model-fallback/index.ts";
import { truncAt } from "../../shared/text.ts";
import {
	loadContextEntries,
	normalizeProjectPath,
	pathExists,
	requireFiles,
	validSlug,
	type ContextEntry,
} from "./definitions.ts";

const MAX_DIRTY_EVIDENCE = 4_000;
const MAX_STRUCTURAL_PREVIEW = 1_500;
const MAX_TOTAL_EVIDENCE = 64_000;
const MAX_UNTRACKED_BYTES = 12_000;
const EVIDENCE_CONCURRENCY = 4;

const SUBMIT_TOOL = {
	name: "submit_context_sync",
	description: "Submit the desired context catalog changes.",
	parameters: Type.Union([
		Type.Object(
			{ outcome: Type.Literal("no-change"), reason: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
		Type.Object(
			{
				outcome: Type.Literal("apply"),
				reason: Type.String({ minLength: 1 }),
				changes: Type.Array(
					Type.Union([
						Type.Object(
							{
								action: Type.Literal("set-entry"),
								tab: Type.String(),
								concept: Type.String(),
								conceptName: Type.String(),
								conceptDescription: Type.String(),
								entry: Type.String(),
								description: Type.String(),
								files: Type.Array(Type.String(), { minItems: 1 }),
							},
							{ additionalProperties: false },
						),
						Type.Object(
							{
								action: Type.Literal("delete-entry"),
								tab: Type.String(),
								concept: Type.String(),
								entry: Type.String(),
							},
							{ additionalProperties: false },
						),
					]),
					{ minItems: 1 },
				),
			},
			{ additionalProperties: false },
		),
	]),
} satisfies Tool;

export interface SyncDirtyFile {
	id: number;
	path: string;
	status: string;
	kind: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked";
	untracked: boolean;
	oldPath?: string;
	memberships: string[];
	oldMemberships: string[];
	evidence: string;
}

export type ContextSyncChange =
	| {
			action: "set-entry";
			tab: string;
			concept: string;
			conceptName: string;
			conceptDescription: string;
			entry: string;
			description: string;
			files: string[];
	  }
	| { action: "delete-entry"; tab: string; concept: string; entry: string };

export type ContextSyncPlan =
	| { outcome: "no-change"; reason: string }
	| { outcome: "apply"; reason: string; changes: ContextSyncChange[] };

export interface ContextSyncDetails {
	outcome: "applied" | "no-change";
	summary: string;
	changedContextFiles: string[];
	reason: string;
	changes: ContextSyncChange[];
	counts: { created: number; updated: number; deleted: number; unchanged: number };
}

export interface SyncEvidence {
	root: string;
	files: SyncDirtyFile[];
	entries: ContextEntry[];
	dirtyExisting: Set<string>;
	dependencies: Set<string>;
	affectedIds: Set<string>;
	affectedConcepts: Set<string>;
	eligibleFiles: Set<string>;
	missingPaths: Set<string>;
	structuralPreviews: Map<string, string>;
	worktreeSignature: string;
	catalogSignature: string;
}

let syncQueue = Promise.resolve();

export async function runContextSync(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ContextSyncDetails> {
	if (!ctx.isProjectTrusted()) throw new Error("Context sync requires a trusted project");
	const git = createGitRunner(pi, ctx);
	const status = await loadRepoStatus(git);
	if (!status) throw new Error("No Git repository found");
	if (status.fileCount === 0) return noChange("Existing context mappings already fit the changed scope.");
	const evidence = await collectSyncEvidence(git, status.root);
	const prompt = buildContextSyncPrompt(evidence);
	const plan = await generateToolValidated(
		ctx,
		await resolveCandidates(ctx),
		prompt,
		SUBMIT_TOOL,
		(input) => normalizeContextSyncPlan(input, evidence),
		(error) => `Validation failed: ${error.message}\nCall submit_context_sync once with corrected arguments only.`,
		{ statusKey: "context-sync", notifyOnFallback: true },
	);
	if (plan.outcome === "no-change") return noChange(plan.reason);
	return withSyncLock(async () => {
		return applyContextSyncPlan(evidence.root, plan, evidence.entries, async () => {
			const currentEntries = await loadContextEntries(evidence.root);
			const currentFiles = await collectDirtyFiles(git, evidence.root, currentEntries);
			if ((await computeWorktreeSignature(git, evidence.root, currentFiles)) !== evidence.worktreeSignature)
				throw new Error("Repository changed during context sync. Rerun context sync.");
			if ((await computeCatalogSignature(evidence.root)) !== evidence.catalogSignature)
				throw new Error("Context catalog changed during context sync. Rerun context sync.");
		});
	});
}

function noChange(reason: string): ContextSyncDetails {
	return {
		outcome: "no-change",
		summary: "Existing context mappings already fit the changed scope.",
		changedContextFiles: [],
		reason,
		changes: [],
		counts: { created: 0, updated: 0, deleted: 0, unchanged: 0 },
	};
}

async function withSyncLock<T>(task: () => Promise<T>): Promise<T> {
	const previous = syncQueue;
	let release = () => {};
	syncQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await task();
	} finally {
		release();
	}
}

async function collectSyncEvidence(git: GitRunner, root: string): Promise<SyncEvidence> {
	const entries = await loadContextEntries(root);
	const files = await collectDirtyFiles(git, root, entries);
	const dirtyExisting = new Set<string>();
	for (const file of files)
		if (file.kind !== "deleted" && (await isFile(join(root, file.path)))) dirtyExisting.add(file.path);
	const dependencies = await discoverDirectDependencies(
		root,
		files.filter((file) => dirtyExisting.has(file.path)),
	);
	const affectedIds = new Set<string>();
	for (const entry of entries) {
		if (
			entry.files.some(
				(path) => files.some((file) => file.path === path || file.oldPath === path) || dependencies.has(path),
			)
		)
			affectedIds.add(entry.id);
	}
	const affectedConcepts = new Set([...affectedIds].map((id) => id.split("/").slice(0, 2).join("/")));
	const siblingEntries = entries.filter((entry) => affectedConcepts.has(`${entry.tab}/${entry.concept}`));
	const missingPaths = new Set<string>();
	for (const entry of entries)
		for (const path of entry.files) if (!(await isFile(join(root, path)))) missingPaths.add(path);
	const siblingFiles = siblingEntries.flatMap((entry) => entry.files).filter((path) => !missingPaths.has(path));
	const eligibleFiles = new Set([...dirtyExisting, ...dependencies, ...siblingFiles]);
	const structuralPreviews = new Map<string, string>();
	for (const path of [...new Set(siblingFiles)].sort()) {
		try {
			const content = await readFile(join(root, path), "utf8");
			const lines = content
				.split("\n")
				.filter((line) => line.trim())
				.slice(0, 30)
				.join("\n");
			structuralPreviews.set(path, truncAt(lines, MAX_STRUCTURAL_PREVIEW));
		} catch {
			structuralPreviews.set(path, "preview unavailable");
		}
	}
	return {
		root,
		files,
		entries,
		dirtyExisting,
		dependencies,
		affectedIds,
		affectedConcepts,
		eligibleFiles,
		missingPaths,
		structuralPreviews,
		worktreeSignature: await computeWorktreeSignature(git, root, files),
		catalogSignature: await computeCatalogSignature(root),
	};
}

async function collectDirtyFiles(
	git: GitRunner,
	root: string,
	entries: readonly ContextEntry[],
): Promise<SyncDirtyFile[]> {
	const raw = await git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root });
	const parts = raw.split("\0").filter(Boolean);
	const parsed: Omit<SyncDirtyFile, "id" | "memberships" | "oldMemberships" | "evidence">[] = [];
	for (let index = 0; index < parts.length; index++) {
		const record = parts[index];
		if (!record) continue;
		if (record[0] === "u")
			throw new Error("Unmerged conflict entries detected; resolve conflicts before context sync.");
		if (record[0] === "?") {
			parsed.push({ path: record.slice(2), status: "??", kind: "untracked", untracked: true });
			continue;
		}
		const fields = record.split(" ");
		if (record[0] === "1") {
			const status = (fields[1] ?? "..").replace(/\./g, " ");
			parsed.push({
				path: fields.slice(8).join(" "),
				status,
				kind: status.includes("D") ? "deleted" : status.includes("A") ? "added" : "modified",
				untracked: false,
			});
		} else if (record[0] === "2") {
			const oldPath = parts[index + 1];
			const status = (fields[1] ?? "..").replace(/\./g, " ");
			parsed.push({
				path: fields.slice(9).join(" "),
				status,
				kind: fields[8]?.startsWith("C") ? "copied" : "renamed",
				untracked: false,
				...(oldPath ? { oldPath } : {}),
			});
			index++;
		}
	}
	const sorted = parsed.sort((a, b) => a.path.localeCompare(b.path));
	const result: SyncDirtyFile[] = [];
	for (let offset = 0; offset < sorted.length; offset += EVIDENCE_CONCURRENCY) {
		result.push(
			...(await Promise.all(
				sorted.slice(offset, offset + EVIDENCE_CONCURRENCY).map(async (file, inner) => ({
					...file,
					id: offset + inner + 1,
					memberships: entries.filter((entry) => entry.files.includes(file.path)).map((entry) => entry.id),
					oldMemberships: file.oldPath
						? entries.filter((entry) => entry.files.includes(file.oldPath ?? "")).map((entry) => entry.id)
						: [],
					evidence: await dirtyEvidence(git, root, file),
				})),
			)),
		);
	}
	return result;
}

async function dirtyEvidence(
	git: GitRunner,
	root: string,
	file: { path: string; oldPath?: string; kind: string; untracked: boolean },
): Promise<string> {
	if (file.kind === "deleted") return "deleted file; contents omitted";
	if (file.untracked) {
		try {
			const info = await stat(join(root, file.path));
			if (!info.isFile()) return "untracked non-file; contents omitted";
			if (info.size > MAX_UNTRACKED_BYTES) return `untracked file, ${info.size} bytes; contents omitted`;
			const bytes = await readFile(join(root, file.path));
			if (bytes.includes(0)) return `untracked binary file, ${info.size} bytes`;
			return truncAt(`untracked file preview:\n${bytes.toString("utf8")}`, MAX_DIRTY_EVIDENCE);
		} catch {
			return "untracked preview unavailable";
		}
	}
	const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
	const diff = await git.run(["diff", "--stat", "--patch", "--no-color", "--no-ext-diff", "HEAD", "--", ...paths], {
		cwd: root,
		optional: true,
	});
	return truncAt(diff || "metadata-only change", MAX_DIRTY_EVIDENCE);
}

export async function discoverDirectDependencies(
	root: string,
	files: readonly Pick<SyncDirtyFile, "path" | "evidence">[],
): Promise<Set<string>> {
	const result = new Set<string>();
	const knownExtensions = [
		".ts",
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs",
		".json",
		".py",
		".rs",
		".go",
		".c",
		".cc",
		".cpp",
		".h",
		".hpp",
	];
	for (const file of files) {
		let content = file.evidence;
		try {
			content += `\n${await readFile(join(root, file.path), "utf8")}`;
		} catch {
			/* evidence remains */
		}
		const statement = /(?:import|export|require|include|use|mod(?:ule)?)\b[^\n]*?["'`]([^"'`]+)["'`]/g;
		for (const match of content.matchAll(statement)) {
			const specifier = match[1];
			if (!specifier?.startsWith("./") && !specifier?.startsWith("../")) continue;
			const absolute = resolve(dirname(join(root, file.path)), specifier);
			const relativePath = relative(root, absolute).split(sep).join("/");
			if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) continue;
			const candidates = extname(absolute)
				? [absolute]
				: [
						...knownExtensions.map((extension) => `${absolute}${extension}`),
						...knownExtensions.map((extension) => join(absolute, `index${extension}`)),
					];
			const matches: string[] = [];
			if (await isFile(absolute)) matches.push(absolute);
			else for (const candidate of candidates) if (await isFile(candidate)) matches.push(candidate);
			if (matches.length === 1)
				result.add(
					relative(root, matches[0] ?? absolute)
						.split(sep)
						.join("/"),
				);
		}
	}
	return result;
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

function buildContextSyncPrompt(evidence: SyncEvidence): string {
	const stale = evidence.entries.flatMap((entry) =>
		entry.files
			.filter(
				(path) =>
					evidence.missingPaths.has(path) &&
					!evidence.files.some((file) => file.path === path || file.oldPath === path),
			)
			.map((path) => `${entry.id}: ${path}`),
	);
	const affected = evidence.entries.filter((entry) => evidence.affectedIds.has(entry.id));
	const previews = [...evidence.structuralPreviews].map(([path, preview]) => `${path}\n${preview}`);
	return truncAt(
		[
			"Synchronize reusable repository context scopes from the supplied Git and catalog evidence.",
			"Call submit_context_sync exactly once and produce no prose response.",
			"Return no-change when existing mappings already support likely future work.",
			"Context entries are reusable work scopes, not inventories of every touched file. Prefer updating an existing entry over creating a near-duplicate. Do not create one entry per file.",
			"Follow direct local dependency candidates only when needed. Do not add package dependencies, generated files, incidental imports, or recursive dependencies.",
			"Reconsider granularity only inside affected concepts. Preserve broad entries when splitting would duplicate files without improving future work.",
			"New or unmapped changed files may remain unmapped. Do not clean unrelated stale paths. Use only supplied candidate paths.",
			"Example: replace gameplay/player/all with gameplay/player/movement and gameplay/player/input only when every still-useful file from all remains in the final entries.",
			"Changed-file catalog and current memberships:",
			...evidence.files.map(
				(file) =>
					`[${file.id}] ${file.status} ${file.path}${file.oldPath ? ` <- ${file.oldPath}` : ""}; kind=${file.kind}; memberships=${file.memberships.join(",") || "none"}; oldMemberships=${file.oldMemberships.join(",") || "none"}`,
			),
			"Complete context catalog:",
			JSON.stringify(
				evidence.entries.map((entry) => ({
					id: entry.id,
					conceptName: entry.conceptName,
					conceptDescription: entry.conceptDescription,
					description: entry.description,
					files: entry.files,
					missingFiles: entry.files.filter((path) => evidence.missingPaths.has(path)),
				})),
			),
			"Changed files with no membership:",
			evidence.files
				.filter((file) => file.memberships.length === 0 && file.oldMemberships.length === 0)
				.map((file) => file.path)
				.join("\n") || "(none)",
			"Affected entries:",
			affected.map((entry) => entry.id).join("\n") || "(none)",
			"Affected concepts:",
			[...evidence.affectedConcepts].sort().join("\n") || "(none)",
			"Resolved direct dependency candidates:",
			[...evidence.dependencies].sort().join("\n") || "(none)",
			"Unrelated stale catalog paths (evidence only; do not modify):",
			stale.join("\n") || "(none)",
			"Dirty files:",
			...evidence.files.map(
				(file) =>
					`[${file.id}] ${file.status} ${file.path}${file.oldPath ? ` <- ${file.oldPath}` : ""}\nkind=${file.kind}\nmemberships=${file.memberships.join(",") || "none"}\noldMemberships=${file.oldMemberships.join(",") || "none"}\n${file.evidence}`,
			),
			"Bounded affected-entry structural previews:",
			...previews,
		].join("\n\n"),
		MAX_TOTAL_EVIDENCE,
	);
}

export function normalizeContextSyncPlan(input: unknown, evidence: SyncEvidence): ContextSyncPlan {
	if (!isRecord(input) || (input.outcome !== "no-change" && input.outcome !== "apply"))
		throw new Error("Context sync submission is malformed.");
	const reason = typeof input.reason === "string" ? input.reason.trim() : "";
	if (!reason) throw new Error("Context sync reason is required.");
	if (input.outcome === "no-change") {
		if ("changes" in input) throw new Error("no-change must not include changes.");
		return { outcome: "no-change", reason };
	}
	if (!Array.isArray(input.changes) || input.changes.length === 0)
		throw new Error("apply requires at least one change.");
	const current = new Map(evidence.entries.map((entry) => [entry.id, entry]));
	const changes: ContextSyncChange[] = [];
	const seen = new Set<string>();
	for (const raw of input.changes) {
		if (!isRecord(raw) || (raw.action !== "set-entry" && raw.action !== "delete-entry"))
			throw new Error("Invalid context sync change.");
		const tab = validSlug(String(raw.tab ?? ""), "Context tab");
		const concept = validSlug(String(raw.concept ?? ""), "Context concept");
		const entry = validSlug(String(raw.entry ?? ""), "Context entry");
		const id = `${tab}/${concept}/${entry}`;
		if (seen.has(id)) throw new Error(`Duplicate context change: ${id}`);
		seen.add(id);
		const existing = current.get(id);
		if (raw.action === "delete-entry") {
			if (!existing || !evidence.affectedIds.has(id)) throw new Error(`Entry is not eligible for deletion: ${id}`);
			changes.push({ action: "delete-entry", tab, concept, entry });
			continue;
		}
		const conceptName = typeof raw.conceptName === "string" ? raw.conceptName.trim() : "";
		const conceptDescription = typeof raw.conceptDescription === "string" ? raw.conceptDescription.trim() : "";
		const description = typeof raw.description === "string" ? raw.description.trim() : "";
		if (
			!conceptName ||
			!description ||
			!Array.isArray(raw.files) ||
			raw.files.length === 0 ||
			raw.files.some((path) => typeof path !== "string")
		)
			throw new Error(`Invalid set-entry: ${id}`);
		const files = [
			...new Set((raw.files as string[]).map((path) => normalizeProjectPath(evidence.root, path))),
		].sort();
		if (files.some((path) => !evidence.eligibleFiles.has(path)))
			throw new Error(`Entry uses a path outside the eligible scope: ${id}`);
		if (existing) {
			const conceptId = `${tab}/${concept}`;
			if (!evidence.affectedIds.has(id) && !evidence.affectedConcepts.has(conceptId))
				throw new Error(`Entry is unrelated: ${id}`);
			if (conceptName !== existing.conceptName || conceptDescription !== existing.conceptDescription)
				throw new Error(`Existing concept metadata cannot change: ${conceptId}`);
			if (description === existing.description && files.join("\0") === existing.files.join("\0"))
				throw new Error(`Set-entry is identical: ${id}`);
		} else {
			const existingConcept = evidence.entries.find((item) => item.tab === tab && item.concept === concept);
			if (
				existingConcept &&
				(conceptName !== existingConcept.conceptName || conceptDescription !== existingConcept.conceptDescription)
			)
				throw new Error(`Existing concept metadata cannot change: ${tab}/${concept}`);
			if (!files.some((path) => evidence.dirtyExisting.has(path) || evidence.dependencies.has(path)))
				throw new Error(`New entry lacks a dirty file or dependency: ${id}`);
			if (
				!existingConcept &&
				(!files.some((path) => evidence.dirtyExisting.has(path)) ||
					files.some((path) => !evidence.eligibleFiles.has(path)))
			)
				throw new Error(`New concept is outside the affected scope: ${tab}/${concept}`);
		}
		changes.push({ action: "set-entry", tab, concept, conceptName, conceptDescription, entry, description, files });
	}
	const final = new Map(evidence.entries.map((entry) => [entry.id, [...entry.files]]));
	for (const change of changes) {
		const id = `${change.tab}/${change.concept}/${change.entry}`;
		if (change.action === "delete-entry") final.delete(id);
		else final.set(id, change.files);
	}
	for (const change of changes.filter(
		(item): item is Extract<ContextSyncChange, { action: "delete-entry" }> => item.action === "delete-entry",
	)) {
		const old = current.get(`${change.tab}/${change.concept}/${change.entry}`);
		if (!old) continue;
		for (const path of old.files)
			if (evidence.eligibleFiles.has(path) && ![...final.values()].some((files) => files.includes(path)))
				throw new Error(`Deleting entry would orphan surviving file: ${path}`);
	}
	return { outcome: "apply", reason, changes };
}

async function computeWorktreeSignature(
	git: GitRunner,
	root: string,
	files: readonly Pick<SyncDirtyFile, "path" | "untracked">[],
): Promise<string> {
	const hash = createHash("sha256");
	const status = await git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root });
	const [staged, unstaged] = await Promise.all([
		git.run(["diff", "--cached", "--no-color", "--no-ext-diff"], { cwd: root, optional: true }),
		git.run(["diff", "--no-color", "--no-ext-diff"], { cwd: root, optional: true }),
	]);
	hash.update(status);
	hash.update("\0staged\0");
	hash.update(staged);
	hash.update("\0unstaged\0");
	hash.update(unstaged);
	for (const file of files.filter((item) => item.untracked).sort((a, b) => a.path.localeCompare(b.path))) {
		try {
			const info = await stat(join(root, file.path));
			hash.update(`\0${file.path}:${info.size}:${info.mtimeMs}`);
			if (info.isFile() && info.size <= MAX_UNTRACKED_BYTES) hash.update(await readFile(join(root, file.path)));
		} catch {
			hash.update(`\0${file.path}:missing`);
		}
	}
	return hash.digest("hex");
}

async function computeCatalogSignature(root: string): Promise<string> {
	const hash = createHash("sha256");
	const base = join(root, ".pi", "contexts");
	if (!(await pathExists(base))) return hash.digest("hex");
	for (const tab of (await readdir(base, { withFileTypes: true }))
		.filter((item) => item.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))) {
		for (const file of (await readdir(join(base, tab.name), { withFileTypes: true }))
			.filter((item) => item.isFile() && extname(item.name) === ".toml")
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(base, tab.name, file.name);
			hash.update(relative(root, path));
			hash.update("\0");
			hash.update(await readFile(path));
			hash.update("\0");
		}
	}
	return hash.digest("hex");
}

export async function applyContextSyncPlan(
	root: string,
	plan: Extract<ContextSyncPlan, { outcome: "apply" }>,
	entries: readonly ContextEntry[],
	verifyFreshness?: () => Promise<void>,
): Promise<ContextSyncDetails> {
	for (const change of plan.changes) if (change.action === "set-entry") await requireFiles(root, change.files);
	const concepts = [...new Set(plan.changes.map((change) => `${change.tab}/${change.concept}`))].sort();
	const outputs = new Map<string, string | undefined>();
	for (const key of concepts) {
		const [tab, concept] = key.split("/");
		if (!tab || !concept) continue;
		const path = join(root, ".pi", "contexts", tab, `${concept}.toml`);
		const raw: Record<string, unknown> = (await pathExists(path))
			? (parse(await readFile(path, "utf8")) as Record<string, unknown>)
			: {};
		for (const change of plan.changes.filter((item) => item.tab === tab && item.concept === concept)) {
			if (change.action === "delete-entry") delete raw[change.entry];
			else {
				if (raw.name === undefined) raw.name = change.conceptName;
				if (raw.description === undefined) raw.description = change.conceptDescription;
				raw[change.entry] = { description: change.description, files: change.files };
			}
		}
		outputs.set(
			path,
			Object.keys(raw).some((key) => key !== "name" && key !== "description") ? stringify(raw) : undefined,
		);
	}
	const paths = [...outputs.keys()].sort();
	const lockPaths = [...new Set([...paths, ...entries.map((entry) => entry.path)])].sort();
	const originals = new Map<string, Buffer | undefined>();
	for (const path of paths) originals.set(path, (await pathExists(path)) ? await readFile(path) : undefined);
	const temporaryFiles = new Map<string, string>();
	try {
		for (const path of paths) {
			const output = outputs.get(path);
			if (output === undefined) continue;
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${process.pid}.${Date.now()}.${temporaryFiles.size}.tmp`;
			await writeFile(temporary, output, "utf8");
			temporaryFiles.set(path, temporary);
		}
		await acquireMutationQueues(lockPaths, async () => {
			await verifyFreshness?.();
			const changed: string[] = [];
			try {
				for (const path of paths) {
					const temporary = temporaryFiles.get(path);
					if (!temporary) await rm(path, { force: true });
					else await rename(temporary, path);
					changed.push(path);
				}
			} catch (error) {
				for (const path of changed.reverse()) {
					const original = originals.get(path);
					if (original === undefined) await rm(path, { force: true });
					else {
						await mkdir(dirname(path), { recursive: true });
						await writeFile(path, original);
					}
				}
				throw error;
			}
		});
	} finally {
		await Promise.all([...temporaryFiles.values()].map((path) => rm(path, { force: true })));
	}
	for (const path of paths.filter((path) => outputs.get(path) === undefined))
		await rm(dirname(path), { recursive: false }).catch(() => undefined);
	const currentIds = new Set(entries.map((entry) => entry.id));
	const created = plan.changes.filter(
		(change) => change.action === "set-entry" && !currentIds.has(`${change.tab}/${change.concept}/${change.entry}`),
	).length;
	const updated = plan.changes.filter(
		(change) => change.action === "set-entry" && currentIds.has(`${change.tab}/${change.concept}/${change.entry}`),
	).length;
	const deleted = plan.changes.filter((change) => change.action === "delete-entry").length;
	const changedContextFiles = paths.map((path) => relative(root, path).split(sep).join("/"));
	const summary = `Updated ${updated} context entries; created ${created}; removed ${deleted}.`;
	return {
		outcome: "applied",
		summary,
		changedContextFiles,
		reason: plan.reason,
		changes: plan.changes,
		counts: { created, updated, deleted, unchanged: entries.length - updated - deleted },
	};
}

async function acquireMutationQueues<T>(paths: readonly string[], task: () => Promise<T>, index = 0): Promise<T> {
	const path = paths[index];
	if (!path) return task();
	return withFileMutationQueue(path, () => acquireMutationQueues(paths, task, index + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
