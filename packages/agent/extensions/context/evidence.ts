import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createGitRunner, loadRepoStatus, type GitRunner } from "../../shared/git.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { truncAt } from "../../shared/text.ts";
import {
	contextEntryPaths,
	isContextEligiblePath,
	isSensitiveContextPath,
	loadContextEntries,
	type ContextEntry,
} from "./definitions.ts";
import contextSettings from "./settings.ts";
import { formatContextValidationFailure, validateContextCatalog } from "./validation.ts";

export const CONTEXT_SYNC_EVIDENCE_TOOL = "context_sync_evidence";

const MAX_DIRTY_EVIDENCE = 4_000;
const MAX_STRUCTURAL_PREVIEW = 1_500;
const MAX_SECTION = 48_000;
const MAX_UNTRACKED_BYTES = 12_000;
const EVIDENCE_CONCURRENCY = 4;

const evidenceParams = Type.Object(
	{
		section: Type.Union(
			[
				Type.Literal("overview"),
				Type.Literal("catalog"),
				Type.Literal("dirty"),
				Type.Literal("file"),
				Type.Literal("dependencies"),
				Type.Literal("previews"),
				Type.Literal("invariants"),
			],
			{
				description:
					"Evidence slice to load. Use overview first, then file/previews/invariants as needed. Call invariants after catalog edits.",
			},
		),
		path: Type.Optional(
			Type.String({
				description: "Project-relative path required when section is file.",
			}),
		),
	},
	{ additionalProperties: false },
);

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

export interface SyncEvidence {
	root: string;
	ignoreGlobs: readonly string[];
	files: SyncDirtyFile[];
	entries: ContextEntry[];
	dirtyExisting: Set<string>;
	dependencies: Set<string>;
	affectedIds: Set<string>;
	affectedConcepts: Set<string>;
	eligibleFiles: Set<string>;
	missingPaths: Set<string>;
	structuralPreviews: Map<string, string>;
}

export function registerContextSyncEvidenceTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool<typeof evidenceParams>({
			name: CONTEXT_SYNC_EVIDENCE_TOOL,
			label: "context_sync_evidence",
			description:
				"Load repository and context-catalog evidence for context-sync. Prefer overview, then narrower sections.",
			parameters: evidenceParams,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const text = await loadEvidenceSection(pi, ctx, params.section, params.path);
				return { content: [{ type: "text" as const, text }], details: undefined };
			},
			renderCall(args, theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const suffix = args.path ? ` ${args.path}` : "";
				text.setText(theme.fg("toolTitle", `${CONTEXT_SYNC_EVIDENCE_TOOL} ${args.section}${suffix}`));
				return text;
			},
			renderResult(result, options, theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const output = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				text.setText(options.isPartial ? theme.fg("dim", output) : truncAt(output, 400));
				return text;
			},
		}),
	);
}

export function hideContextSyncEvidenceTool(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (!active.includes(CONTEXT_SYNC_EVIDENCE_TOOL)) return;
	// Keep active in the context-sync child toolset (may include bash for read-only inspection).
	const parentMarkers = ["subagent", "edit", "write", "load_tools"];
	if (!parentMarkers.some((name) => active.includes(name))) return;
	pi.setActiveTools(active.filter((name) => name !== CONTEXT_SYNC_EVIDENCE_TOOL));
}

export async function collectSyncEvidence(
	git: GitRunner,
	root: string,
	ignoreGlobs: readonly string[],
): Promise<SyncEvidence> {
	const entries = await loadContextEntries(root);
	const files = await collectDirtyFiles(git, root, entries, ignoreGlobs);
	const dirtyExisting = new Set<string>();
	for (const file of files)
		if (file.kind !== "deleted" && (await isFile(join(root, file.path)))) dirtyExisting.add(file.path);
	const dependencies = await discoverDirectDependencies(
		root,
		files.filter((file) => dirtyExisting.has(file.path)),
	);
	for (const path of dependencies) if (!isContextEligiblePath(path, ignoreGlobs)) dependencies.delete(path);
	const missingPaths = new Set<string>();
	for (const entry of entries)
		for (const path of contextEntryPaths(entry))
			if (isContextEligiblePath(path, ignoreGlobs) && !(await isFile(join(root, path)))) missingPaths.add(path);
	const affectedIds = new Set<string>();
	for (const entry of entries) {
		const paths = contextEntryPaths(entry);
		if (
			paths.some((path) => missingPaths.has(path)) ||
			paths.some(
				(path) => files.some((file) => file.path === path || file.oldPath === path) || dependencies.has(path),
			)
		)
			affectedIds.add(entry.id);
	}
	const affectedConcepts = new Set([...affectedIds].map((id) => id.split("/").slice(0, 2).join("/")));
	const siblingEntries = entries.filter((entry) => affectedConcepts.has(`${entry.tab}/${entry.concept}`));
	const siblingFiles = siblingEntries
		.flatMap((entry) => contextEntryPaths(entry))
		.filter((path) => !missingPaths.has(path) && isContextEligiblePath(path, ignoreGlobs));
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
		ignoreGlobs,
		files,
		entries,
		dirtyExisting,
		dependencies,
		affectedIds,
		affectedConcepts,
		eligibleFiles,
		missingPaths,
		structuralPreviews,
	};
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

export function formatEvidenceSection(evidence: SyncEvidence, section: string, path?: string): string {
	switch (section) {
		case "overview":
			return truncAt(formatOverview(evidence), MAX_SECTION);
		case "catalog":
			return truncAt(formatCatalog(evidence), MAX_SECTION);
		case "dirty":
			return truncAt(formatDirty(evidence), MAX_SECTION);
		case "file": {
			const target = path?.trim();
			if (!target) throw new Error("path is required when section is file");
			const file = evidence.files.find((item) => item.path === target || item.oldPath === target);
			if (!file) throw new Error(`No dirty evidence for path: ${target}`);
			return truncAt(formatDirtyFile(file), MAX_SECTION);
		}
		case "dependencies":
			return truncAt(
				["Resolved direct dependency candidates:", ...[...evidence.dependencies].sort()].join("\n") ||
					"Resolved direct dependency candidates:\n(none)",
				MAX_SECTION,
			);
		case "previews":
			return truncAt(formatPreviews(evidence), MAX_SECTION);
		case "invariants":
			return truncAt(formatInvariants(evidence), MAX_SECTION);
		default:
			throw new Error(`Unknown evidence section: ${section}`);
	}
}

async function loadEvidenceSection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	section: string,
	path: string | undefined,
): Promise<string> {
	if (!ctx.isProjectTrusted()) throw new Error("Context sync evidence requires a trusted project");
	const git = createGitRunner(pi, ctx);
	const status = await loadRepoStatus(git);
	if (!status) throw new Error("No Git repository found");
	const settings = await loadTauExtensionSettings(ctx, contextSettings);
	if (section === "invariants") {
		const failure = formatContextValidationFailure(
			await validateContextCatalog(git, status.root, settings.validation.ignoreGlobs),
		);
		return failure ?? "Context catalog invariants hold. No uncovered eligible dirty files. No stale catalog paths.";
	}
	const evidence = await collectSyncEvidence(git, status.root, settings.validation.ignoreGlobs);
	return formatEvidenceSection(evidence, section, path);
}

function formatOverview(evidence: SyncEvidence): string {
	const uncovered = evidence.files
		.filter((file) => file.kind !== "deleted" && file.memberships.length === 0)
		.map((file) => file.path);
	const stale = [...evidence.missingPaths].sort();
	return [
		`Project root: ${evidence.root}`,
		`Ignore globs: ${evidence.ignoreGlobs.join(", ") || "(none)"}`,
		"",
		"Ladder (answer in order before editing):",
		"1. Domain (tab/folder): reuse, new, or split?",
		"2. Concept (toml): reuse, new, split, or merge?",
		"3. Entry (section): update, new, split, delete, or move?",
		"4. Bloat: any touched scope now a junk drawer?",
		"5. Membership: files/anchors under winners only. Preserve existing read vs anchor class.",
		"",
		"Edit only files under .pi/contexts/. Use patch. Do not use bash.",
		"Every eligible changed non-deleted file must belong to at least one entry. Remove every stale catalog path.",
		"Prefer honest typology over stuffing paths into the nearest existing feature bucket.",
		"",
		`Dirty eligible files: ${evidence.files.length}`,
		`Uncovered changed files: ${uncovered.length}`,
		`Stale catalog paths: ${stale.length}`,
		`Affected entries: ${evidence.affectedIds.size}`,
		`Affected concepts: ${evidence.affectedConcepts.size}`,
		`Direct dependencies: ${evidence.dependencies.size}`,
		"",
		"Changed files with no membership:",
		...(uncovered.length ? uncovered.map((path) => `- ${path}`) : ["(none)"]),
		"",
		"Stale catalog paths:",
		...(stale.length ? stale.map((path) => `- ${path}`) : ["(none)"]),
		"",
		"Affected entries:",
		...(evidence.affectedIds.size ? [...evidence.affectedIds].sort().map((id) => `- ${id}`) : ["(none)"]),
		"",
		"Affected concepts:",
		...(evidence.affectedConcepts.size ? [...evidence.affectedConcepts].sort().map((id) => `- ${id}`) : ["(none)"]),
		"",
		"Dirty file index:",
		...evidence.files.map(
			(file) =>
				`[${file.id}] ${file.status} ${file.path}${file.oldPath ? ` <- ${file.oldPath}` : ""} kind=${file.kind} memberships=${file.memberships.join(",") || "none"} oldMemberships=${file.oldMemberships.join(",") || "none"}`,
		),
		"",
		"Next: context_sync_evidence section=catalog, then dirty or file as needed. After edits, section=invariants.",
	].join("\n");
}

function formatCatalog(evidence: SyncEvidence): string {
	return [
		"Complete context catalog skeleton:",
		JSON.stringify(
			evidence.entries.map((entry) => ({
				id: entry.id,
				tab: entry.tab,
				concept: entry.concept,
				conceptName: entry.conceptName,
				conceptDescription: entry.conceptDescription,
				entry: entry.name,
				description: entry.description,
				files: entry.files,
				anchors: entry.anchors,
				missing: contextEntryPaths(entry).filter((path) => evidence.missingPaths.has(path)),
				path: entry.path,
			})),
			null,
			2,
		),
	].join("\n");
}

function formatDirty(evidence: SyncEvidence): string {
	return ["Dirty files:", ...evidence.files.map((file) => formatDirtyFile(file))].join("\n\n");
}

function formatDirtyFile(file: SyncDirtyFile, includeEvidence = true): string {
	const header = [
		`[${file.id}] ${file.status} ${file.path}${file.oldPath ? ` <- ${file.oldPath}` : ""}`,
		`kind=${file.kind}`,
		`memberships=${file.memberships.join(",") || "none"}`,
		`oldMemberships=${file.oldMemberships.join(",") || "none"}`,
	].join("\n");
	return includeEvidence ? `${header}\n${file.evidence}` : header;
}

function formatPreviews(evidence: SyncEvidence): string {
	const lines = ["Bounded affected-entry structural previews:"];
	if (evidence.structuralPreviews.size === 0) lines.push("(none)");
	else
		for (const [path, preview] of [...evidence.structuralPreviews].sort((a, b) => a[0].localeCompare(b[0]))) {
			lines.push("", path, preview);
		}
	return lines.join("\n");
}

function formatInvariants(evidence: SyncEvidence): string {
	const uncovered = evidence.files
		.filter((file) => file.kind !== "deleted" && file.memberships.length === 0)
		.map((file) => file.path)
		.sort();
	const stale = [...evidence.missingPaths].sort();
	if (uncovered.length === 0 && stale.length === 0)
		return "Context catalog invariants hold. No uncovered eligible dirty files. No stale catalog paths.";
	return [
		"Context catalog invariants failed.",
		"",
		"Uncovered changed files:",
		...(uncovered.length ? uncovered.map((path) => `- ${path}`) : ["(none)"]),
		"",
		"Stale catalog paths:",
		...(stale.length ? stale.map((path) => `- ${path}`) : ["(none)"]),
		"",
		"Continue editing .pi/contexts until invariants hold, then recheck.",
	].join("\n");
}

async function collectDirtyFiles(
	git: GitRunner,
	root: string,
	entries: readonly ContextEntry[],
	ignoreGlobs: readonly string[],
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
	const sensitive = parsed.filter(
		(file) =>
			file.kind !== "deleted" &&
			(isSensitiveContextPath(file.path) || (file.oldPath !== undefined && isSensitiveContextPath(file.oldPath))),
	);
	if (sensitive.length > 0)
		throw new Error(
			`Sensitive files cannot be inspected by context sync:\n${sensitive.map((file) => `- ${file.path}`).join("\n")}`,
		);
	const sorted = parsed
		.filter(
			(file) =>
				isContextEligiblePath(file.path, ignoreGlobs) ||
				(file.oldPath !== undefined && isContextEligiblePath(file.oldPath, ignoreGlobs)),
		)
		.sort((a, b) => a.path.localeCompare(b.path));
	const result: SyncDirtyFile[] = [];
	for (let offset = 0; offset < sorted.length; offset += EVIDENCE_CONCURRENCY) {
		result.push(
			...(await Promise.all(
				sorted.slice(offset, offset + EVIDENCE_CONCURRENCY).map(async (file, inner) => ({
					...file,
					id: offset + inner + 1,
					memberships: entries
						.filter((entry) => contextEntryPaths(entry).includes(file.path))
						.map((entry) => entry.id),
					oldMemberships: file.oldPath
						? entries
								.filter((entry) => contextEntryPaths(entry).includes(file.oldPath ?? ""))
								.map((entry) => entry.id)
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

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
