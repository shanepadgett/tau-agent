import { access, readFile, readdir, stat } from "node:fs/promises";
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
	files: string[];
	anchors: string[];
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
const CONTEXT_ENTRY_FIELDS = new Set(["description", "files", "anchors"]);

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

export function validSlug(value: string, label: string): string {
	const slug = value.trim();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`${label} must use lowercase kebab-case: ${value}`);
	return slug;
}

export function normalizeProjectPath(root: string, input: string): string {
	const absolute = resolve(root, input.trim().replace(/^@/, ""));
	const path = relative(root, absolute).split(sep).join("/");
	if (!path || path === "." || path === ".." || path.startsWith("../"))
		throw new Error(`Path must stay inside project: ${input}`);
	return path;
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function contextEntryPaths(entry: Pick<ContextEntry, "files" | "anchors">): string[] {
	return sortedUnique([...entry.files, ...entry.anchors]);
}

export async function requireFiles(root: string, inputs: readonly string[]): Promise<string[]> {
	const files = sortedUnique(inputs.map((input) => normalizeProjectPath(root, input)));
	for (const file of files) {
		try {
			if (!(await stat(join(root, file))).isFile()) throw new Error();
		} catch {
			throw new Error(`Context file does not exist: ${file}`);
		}
	}
	return files;
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
				const anchors = record.anchors ?? [];
				if (
					typeof record.description !== "string" ||
					!record.description.trim() ||
					!Array.isArray(record.files) ||
					record.files.some((item) => typeof item !== "string") ||
					!Array.isArray(anchors) ||
					anchors.some((item) => typeof item !== "string") ||
					(record.files.length === 0 && anchors.length === 0)
				)
					throw new Error(`Invalid context entry: ${path} [${name}]`);
				const entry = validSlug(name, "Context entry");
				const entryFiles = sortedUnique((record.files as string[]).map((item) => normalizeProjectPath(root, item)));
				const entryAnchors = sortedUnique((anchors as string[]).map((item) => normalizeProjectPath(root, item)));
				const overlap = entryFiles.find((item) => entryAnchors.includes(item));
				if (overlap) throw new Error(`Context path cannot be both file and anchor: ${path} [${name}] ${overlap}`);
				result.push({
					id: `${tab}/${concept}/${entry}`,
					tab,
					concept,
					conceptName,
					conceptDescription,
					name: entry,
					description: record.description.trim(),
					files: entryFiles,
					anchors: entryAnchors,
					path,
				});
			}
		}
	}
	return result;
}
