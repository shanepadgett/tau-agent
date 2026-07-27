import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { matchGlob } from "../../shared/glob.ts";

export interface ContextEntry {
	id: string;
	tab: string;
	concept: string;
	conceptName: string;
	conceptDescription: string;
	name: string;
	description: string;
	read: string[];
	outline: string[];
	references: string[];
	path: string;
}

const CONTEXT_IGNORED_FILENAMES = new Set([
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"composer.lock",
	"flake.lock",
	"Gemfile.lock",
	"go.sum",
	"mix.lock",
	"npm-shrinkwrap.json",
	"package-lock.json",
	"Package.resolved",
	"Pipfile.lock",
	"pnpm-lock.yaml",
	"Podfile.lock",
	"poetry.lock",
	"pubspec.lock",
	"uv.lock",
	"yarn.lock",
]);
const CONTEXT_ENTRY_FIELDS = new Set(["description", "read", "outline", "references"]);

export function isContextEligiblePath(path: string, ignoreGlobs: readonly string[] = []): boolean {
	return (
		path !== "LICENSE" &&
		!CONTEXT_IGNORED_FILENAMES.has(basename(path)) &&
		!ignoreGlobs.some((glob) => matchGlob(glob, path)) &&
		path !== ".pi/tau/ideas.jsonl" &&
		path !== ".working" &&
		!path.startsWith(".working/") &&
		path !== ".pi/contexts" &&
		!path.startsWith(".pi/contexts/")
	);
}

export function isSensitiveContextPath(path: string): boolean {
	const name = basename(path);
	if (name === ".env.example" || name === ".env.sample") return false;
	return name === ".env" || name.startsWith(".env.") || /\.(?:pem|key|crt|p12|pfx)$/i.test(name);
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function findProjectRoot(cwd: string): Promise<string> {
	const home = resolve(homedir());
	let current = resolve(cwd);
	let gitRoot: string | undefined;
	while (true) {
		if (await pathExists(join(current, ".pi", "contexts"))) return current;
		if (!gitRoot && (await pathExists(join(current, ".git")))) gitRoot = current;
		const parent = dirname(current);
		if (parent === current || current === home) break;
		current = parent;
	}
	return gitRoot ?? resolve(cwd);
}

function validSlug(value: string, label: string): string {
	const slug = value.trim();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`${label} must use lowercase kebab-case: ${value}`);
	return slug;
}

function normalizeProjectPath(root: string, input: string): string {
	const absolute = resolve(root, input.trim().replace(/^@/, ""));
	const path = relative(root, absolute).split(sep).join("/");
	if (!path || path === "." || path === ".." || path.startsWith("../"))
		throw new Error(`Path must stay inside project: ${input}`);
	return path;
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function contextEntryPaths(entry: Pick<ContextEntry, "read" | "outline" | "references">): string[] {
	return sortedUnique([...entry.read, ...entry.outline, ...entry.references]);
}

export async function loadContextEntries(root: string): Promise<ContextEntry[]> {
	const contextsRoot = join(root, ".pi", "contexts");
	if (!(await pathExists(contextsRoot))) return [];
	const tabs = (await readdir(contextsRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name));
	const result: ContextEntry[] = [];
	for (const tabEntry of tabs) {
		const tab = validSlug(tabEntry.name, "Context tab");
		const files = (await readdir(join(contextsRoot, tab), { withFileTypes: true }))
			.filter((entry) => entry.isFile() && extname(entry.name) === ".toml")
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const file of files) {
			const path = join(contextsRoot, tab, file.name);
			const concept = validSlug(basename(file.name, ".toml"), "Context concept");
			const raw = parse(await readFile(path, "utf8")) as Record<string, unknown>;
			const conceptName = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : concept;
			const conceptDescription = typeof raw.description === "string" ? raw.description.trim() : "";
			for (const [name, value] of Object.entries(raw)) {
				if (name === "name" || name === "description") continue;
				if (!value || typeof value !== "object" || Array.isArray(value))
					throw new Error(`Invalid context entry: ${path} [${name}]`);
				const record = value as Record<string, unknown>;
				const unknownField = Object.keys(record).find((field) => !CONTEXT_ENTRY_FIELDS.has(field));
				if (unknownField) throw new Error(`Invalid context entry field: ${path} [${name}] ${unknownField}`);
				if (
					typeof record.description !== "string" ||
					!record.description.trim() ||
					!Array.isArray(record.read) ||
					record.read.some((item) => typeof item !== "string") ||
					!Array.isArray(record.outline) ||
					record.outline.some((item) => typeof item !== "string") ||
					!Array.isArray(record.references) ||
					record.references.some((item) => typeof item !== "string") ||
					(record.read.length === 0 && record.outline.length === 0 && record.references.length === 0)
				)
					throw new Error(`Invalid context entry: ${path} [${name}]`);
				const entry = validSlug(name, "Context entry");
				const entryRead = sortedUnique((record.read as string[]).map((item) => normalizeProjectPath(root, item)));
				const entryOutline = sortedUnique(
					(record.outline as string[]).map((item) => normalizeProjectPath(root, item)),
				);
				const entryReferences = sortedUnique(
					(record.references as string[]).map((item) => normalizeProjectPath(root, item)),
				);
				const classified = [...entryRead, ...entryOutline, ...entryReferences];
				const overlap = classified.find((item, index) => classified.indexOf(item) !== index);
				if (overlap) throw new Error(`Context path has multiple loading modes: ${path} [${name}] ${overlap}`);
				result.push({
					id: `${tab}/${concept}/${entry}`,
					tab,
					concept,
					conceptName,
					conceptDescription,
					name: entry,
					description: record.description.trim(),
					read: entryRead,
					outline: entryOutline,
					references: entryReferences,
					path,
				});
			}
		}
	}
	return result;
}
