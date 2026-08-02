import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { matchGlob } from "../../shared/glob.ts";

export type ContextShowView = "signature" | "signatureWithDocs" | "declaration" | "declarationWithImports";

export interface ContextShowTarget {
	path: string;
	name: string;
	view: ContextShowView;
}

export interface ContextEntry {
	id: string;
	tab: string;
	concept: string;
	conceptName: string;
	conceptDescription: string;
	name: string;
	description: string;
	read: string[];
	show: ContextShowTarget[];
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
const CONTEXT_ENTRY_FIELDS = new Set(["description", "read", "show", "outline", "references"]);
const CONTEXT_SHOW_VIEWS = new Set<ContextShowView>([
	"signature",
	"signatureWithDocs",
	"declaration",
	"declarationWithImports",
]);
const CONTEXT_SHOW_TARGET_FIELDS = new Set(["path", "name", "view"]);

export function isContextEligiblePath(path: string, ignoreGlobs: readonly string[] = []): boolean {
	return (
		path !== "LICENSE" &&
		!CONTEXT_IGNORED_FILENAMES.has(basename(path)) &&
		!ignoreGlobs.some((glob) => matchGlob(glob, path)) &&
		path !== ".pi/tau/ideas.jsonl" &&
		path !== ".pi/tau/reviews" &&
		!path.startsWith(".pi/tau/reviews/") &&
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

const TAB_FOLDER_PATTERN = /^(\d{2})_([a-z0-9]+(?:-[a-z0-9]+)*)$/;

function validSlug(value: string, label: string): string {
	const slug = value.trim();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`${label} must use lowercase kebab-case: ${value}`);
	return slug;
}

/** Domain folder: `01_extensions` → order 1, tab slug `extensions` (id/label). */
function parseContextTabFolder(name: string): { order: number; slug: string; folder: string } {
	const match = TAB_FOLDER_PATTERN.exec(name);
	const digits = match?.[1];
	const slug = match?.[2];
	if (!match || digits === undefined || slug === undefined) {
		throw new Error(
			`Context tab folder must be NN_kebab-slug with a two-digit order starting at 01 (e.g. 01_extensions): ${name}`,
		);
	}
	const order = Number(digits);
	if (!Number.isInteger(order) || order < 1 || order > 99) {
		throw new Error(`Context tab order must be an integer from 01 to 99: ${name}`);
	}
	return { order, slug, folder: name };
}

function assertContiguousTabOrders(tabs: readonly { order: number; slug: string; folder: string }[]): void {
	const byOrder = [...tabs].sort((left, right) => left.order - right.order);
	const seenSlugs = new Set<string>();
	for (let index = 0; index < byOrder.length; index++) {
		const tab = byOrder[index];
		if (!tab) continue;
		const expected = index + 1;
		if (tab.order !== expected) {
			throw new Error(
				`Context tab orders must be contiguous from 01 (expected ${String(expected).padStart(2, "0")}_…, found ${tab.folder})`,
			);
		}
		if (seenSlugs.has(tab.slug)) throw new Error(`Duplicate context tab slug: ${tab.slug}`);
		seenSlugs.add(tab.slug);
	}
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

export function contextEntryPaths(entry: Pick<ContextEntry, "read" | "show" | "outline" | "references">): string[] {
	return sortedUnique([
		...entry.read,
		...entry.show.map((target) => target.path),
		...entry.outline,
		...entry.references,
	]);
}

function parseOneShowTarget(root: string, catalogPath: string, entryName: string, item: unknown): ContextShowTarget {
	const record = item as Record<string, unknown>;
	const unknownField = Object.keys(record).find((field) => !CONTEXT_SHOW_TARGET_FIELDS.has(field));
	if (unknownField) throw new Error(`Invalid context show field: ${catalogPath} [${entryName}] ${unknownField}`);
	if (typeof record.path !== "string" || !record.path.trim() || typeof record.name !== "string" || !record.name.trim())
		throw new Error(`Invalid context show target: ${catalogPath} [${entryName}]`);
	let view: ContextShowView = "declaration";
	if (record.view !== undefined) {
		if (typeof record.view !== "string" || !CONTEXT_SHOW_VIEWS.has(record.view as ContextShowView))
			throw new Error(`Invalid context show view: ${catalogPath} [${entryName}] ${String(record.view)}`);
		view = record.view as ContextShowView;
	}
	return {
		path: normalizeProjectPath(root, record.path),
		name: record.name.trim(),
		view,
	};
}

function dedupeShowTargets(catalogPath: string, entryName: string, targets: ContextShowTarget[]): ContextShowTarget[] {
	const seen = new Map<string, ContextShowTarget>();
	for (const target of targets) {
		const key = `${target.path}\0${target.name}`;
		const existing = seen.get(key);
		if (existing && existing.view !== target.view)
			throw new Error(
				`Context show target has multiple views: ${catalogPath} [${entryName}] ${target.path} ${target.name}`,
			);
		if (!existing) seen.set(key, target);
	}
	return [...seen.values()].sort(
		(left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name),
	);
}

function parseShowTargets(root: string, catalogPath: string, entryName: string, raw: unknown): ContextShowTarget[] {
	if (!Array.isArray(raw) || raw.some((item) => !item || typeof item !== "object" || Array.isArray(item)))
		throw new Error(`Invalid context entry show list: ${catalogPath} [${entryName}]`);
	return dedupeShowTargets(
		catalogPath,
		entryName,
		raw.map((item) => parseOneShowTarget(root, catalogPath, entryName, item)),
	);
}

function parseContextEntryRecord(
	root: string,
	path: string,
	tab: string,
	concept: string,
	conceptName: string,
	conceptDescription: string,
	name: string,
	value: unknown,
): ContextEntry {
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
		record.references.some((item) => typeof item !== "string")
	)
		throw new Error(`Invalid context entry: ${path} [${name}]`);
	const entry = validSlug(name, "Context entry");
	const entryRead = sortedUnique((record.read as string[]).map((item) => normalizeProjectPath(root, item)));
	const entryShow = parseShowTargets(root, path, name, record.show ?? []);
	const entryOutline = sortedUnique((record.outline as string[]).map((item) => normalizeProjectPath(root, item)));
	const entryReferences = sortedUnique(
		(record.references as string[]).map((item) => normalizeProjectPath(root, item)),
	);
	if (entryRead.length === 0 && entryShow.length === 0 && entryOutline.length === 0 && entryReferences.length === 0)
		throw new Error(`Invalid context entry: ${path} [${name}]`);
	const classified = [...entryRead, ...entryOutline, ...entryReferences];
	const overlap = classified.find((item, index) => classified.indexOf(item) !== index);
	if (overlap) throw new Error(`Context path has multiple loading modes: ${path} [${name}] ${overlap}`);
	return {
		id: `${tab}/${concept}/${entry}`,
		tab,
		concept,
		conceptName,
		conceptDescription,
		name: entry,
		description: record.description.trim(),
		read: entryRead,
		show: entryShow,
		outline: entryOutline,
		references: entryReferences,
		path,
	};
}

async function loadConceptFile(root: string, tab: string, folder: string, fileName: string): Promise<ContextEntry[]> {
	const path = join(root, ".pi", "contexts", folder, fileName);
	const concept = validSlug(basename(fileName, ".toml"), "Context concept");
	const raw = parse(await readFile(path, "utf8")) as Record<string, unknown>;
	const conceptName = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : concept;
	const conceptDescription = typeof raw.description === "string" ? raw.description.trim() : "";
	const entries: ContextEntry[] = [];
	for (const [name, value] of Object.entries(raw)) {
		if (name === "name" || name === "description") continue;
		entries.push(parseContextEntryRecord(root, path, tab, concept, conceptName, conceptDescription, name, value));
	}
	return entries;
}

export async function loadContextEntries(root: string): Promise<ContextEntry[]> {
	const contextsRoot = join(root, ".pi", "contexts");
	if (!(await pathExists(contextsRoot))) return [];
	const tabs = (await readdir(contextsRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => parseContextTabFolder(entry.name));
	assertContiguousTabOrders(tabs);
	tabs.sort((left, right) => left.order - right.order);
	const result: ContextEntry[] = [];
	for (const tabEntry of tabs) {
		const files = (await readdir(join(contextsRoot, tabEntry.folder), { withFileTypes: true }))
			.filter((entry) => entry.isFile() && extname(entry.name) === ".toml")
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const file of files) {
			result.push(...(await loadConceptFile(root, tabEntry.slug, tabEntry.folder, file.name)));
		}
	}
	return result;
}
