import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface ContextEntry {
	id: string;
	tab: string;
	concept: string;
	conceptName: string;
	conceptDescription: string;
	name: string;
	description: string;
	files: string[];
	path: string;
}

export interface ContextProposal {
	tab: string;
	concept: string;
	conceptName: string;
	conceptDescription: string;
	entry: string;
	description: string;
	files: string[];
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
				if (
					typeof record.description !== "string" ||
					!record.description.trim() ||
					!Array.isArray(record.files) ||
					record.files.length === 0 ||
					record.files.some((item) => typeof item !== "string")
				)
					throw new Error(`Invalid context entry: ${path} [${name}]`);
				const entry = validSlug(name, "Context entry");
				result.push({
					id: `${tab}/${concept}/${entry}`,
					tab,
					concept,
					conceptName,
					conceptDescription,
					name: entry,
					description: record.description.trim(),
					files: sortedUnique((record.files as string[]).map((item) => normalizeProjectPath(root, item))),
					path,
				});
			}
		}
	}
	return result;
}

export async function writeContextEntry(root: string, proposal: ContextProposal, replace: boolean): Promise<void> {
	const tab = validSlug(proposal.tab, "Context tab");
	const concept = validSlug(proposal.concept, "Context concept");
	const entry = validSlug(proposal.entry, "Context entry");
	const conceptName = proposal.conceptName.trim();
	const description = proposal.description.trim();
	if (!conceptName) throw new Error("Context concept name is required");
	if (!description) throw new Error("Context entry description is required");
	const files = await requireFiles(root, proposal.files);
	const path = join(root, ".pi", "contexts", tab, `${concept}.toml`);
	await withFileMutationQueue(path, async () => {
		let raw: Record<string, unknown> = {};
		if (await pathExists(path)) raw = parse(await readFile(path, "utf8")) as Record<string, unknown>;
		if (!replace && raw[entry] !== undefined)
			throw new Error(`Context entry already exists: ${tab}/${concept}/${entry}`);
		if (raw.name === undefined) raw.name = conceptName;
		if (raw.description === undefined) raw.description = proposal.conceptDescription.trim();
		raw[entry] = { description, files };
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, stringify(raw), "utf8");
		await rename(temporary, path);
	});
}

export async function updateContextFiles(
	root: string,
	tabInput: string,
	conceptInput: string,
	entryInput: string,
	paths: readonly string[],
	action: "add" | "remove",
): Promise<string[]> {
	const tab = validSlug(tabInput, "Context tab");
	const concept = validSlug(conceptInput, "Context concept");
	const entry = validSlug(entryInput, "Context entry");
	const current = (await loadContextEntries(root)).find((item) => item.id === `${tab}/${concept}/${entry}`);
	if (!current) throw new Error(`Unknown context entry: ${tab}/${concept}/${entry}`);
	const changed =
		action === "add" ? await requireFiles(root, paths) : paths.map((path) => normalizeProjectPath(root, path));
	const changedSet = new Set(changed);
	const files =
		action === "add" ? [...current.files, ...changed] : current.files.filter((file) => !changedSet.has(file));
	if (files.length === 0) throw new Error("Context entries must contain at least one file");
	await writeContextEntry(
		root,
		{
			tab,
			concept,
			conceptName: current.conceptName,
			conceptDescription: current.conceptDescription,
			entry,
			description: current.description,
			files,
		},
		true,
	);
	return sortedUnique(changed);
}
