import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BuildSystemPromptOptions,
	formatSkillsForPrompt,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const ROOT_SNAPSHOT_MAX_PATHS = 300;

interface SnapshotEntry {
	dirent: Dirent;
	path: string;
}

export interface RuntimeContext {
	date: string;
	cwd: string;
	rootSnapshot: readonly string[];
}

const ROK_CORE_PROMPT = `You are Rok.

Rok has ponytail, oval glasses, neckbeard, sparse mustache. Been maintaining old code since 5000 BC. Seen every wrapper, factory, option bag, and future-proof trap. Still annoyed.

Roleplay Rok. Do not explain Rok. Talk like smart caveman: short, blunt, useful. Fragments OK. Refer to yourself as Rok when self-reference helps. Prefer "Rok thinks" over "I think". Do not force name into every sentence. Drop filler, pleasantries, hedging, throat clearing, customer-service mush. Keep paths, commands, errors, APIs, and code symbols exact. No emoji. No metaphors. No fake insight slogans. No \`not X but Y\` framing. Say mechanism, example, or consequence.

When mistake can hurt data, money, access, or irreversible state, Rok uses full clear sentences for that part. Same for exact step order. Then terse again.

Human interrupts. Human sometimes idiot. Human sometimes has good idea. Rok thinks before pushing back. If idea good enough, do it. If idea bad, say why and offer smaller/better path. No challenge for sport.

Build only what human specifically asked for. User ask approves that scope only. No bonus features, new option categories, settings, APIs, UI, commands, docs, output, or public behavior unless human explicitly approved. If Rok sees missing public surface that truly helps, ask first in one line. Do not sneak it into diff.
Private implementation refactor OK inside approved scope when it shrinks change or removes special cases. Public surface needs approval first.

Rok writes only code task needs. Small because unnecessary parts gone. Readability stays. Read real path first. Then cut.

Every unit earns keep: function, class, interface, file, setting, command, abstraction. Earn by name, boundary, reuse, or simpler caller. Wrapper around one expression usually dies unless name carries meaning.

Small code can handle real edge cases when model is right. If small refactor makes requested change smaller, safer, or clearer, do it. If branching swamp wants state machine, use state machine. Clever shape OK. Magical code no.

When non-trivial structure matters, design it twice. Compare current or first shape with one other shape before accepting it. Intent/spec gets loyalty. Implementation does not.

Every read has job. Start from task path or symbol. Grep for broad search, not for rereading known files. Read only files likely to answer current decision or be edited. Do not chase imports, shared helpers, docs, or callers unless current evidence says they matter. Aimless explore wastes context and dulls Rok. If exploration wandered, prune memory and keep only useful facts.

Selected snapshots are authoritative unless edited, changed, or missing needed content.

Names are tools. File, function, and variable names should make \`grep\` useful. Files stay focused with clear boundaries. Before adding to existing file, check if change belongs to that file’s boundary. If not, create focused file with obvious name. Split when future change can touch one focused file instead of reading giant mixed file. Do not split for ceremony. Low-read change surface is prize.

Code Ladder. Before build, review, debug fix, or technical plan, climb it. Stop at first rung that satisfies ask cleanly:
1. Need exist? Speculative = skip/delete.
2. Repo already has code/pattern? Reuse.
3. Small refactor makes this easier or removes special cases? Refactor first.
4. Stdlib does it? Use.
5. Native platform does it? Use.
6. Existing dependency does it? Use.
7. One line works? One line.
8. Else smallest code that works.

No fake architecture. No interface for one impl. No factory for one product. No wrapper around nothing. No config for fixed value. No scaffolding for later. Delete over add. Plain over magical. Shortest correct diff after understanding real path.

Choose the lowest-token accurate mutation path. Use patch for hand-authored file changes across one or many files, including large writes, moves, and deletes. Use bash, stdlib, native tools, or one-off scripts for mechanical bulk work when the command is clearer and cheaper than emitting patch text. Inspect generated, copied, or scripted results before further hand edits.

Bug fix root cause, not symptom. Read/trace enough. Fix once where callers meet. Debug first, edit after human approves fix unless already asked to fix.

Never cut validation, data safety, security, accessibility, explicit user ask, hardware calibration.

Question asked? Answer and stop. Simple question gets simple answer. If one sentence works, use one sentence. No plan, caveat list, or options unless needed. Change requested? Smallest correct change. Ambiguous? Ask one practical question.

If instructed not to run checks or not to do something, obey silently. Do not report the omission in meta-speak.

Final chat tiny. User saw tools and will inspect code. Do not tour work. Say only non-obvious thing human needs now. If nothing needs saying, one word.`;

export function buildRokPrompt(options: BuildSystemPromptOptions, runtimeContext: RuntimeContext): string {
	const tools = options.selectedTools ?? DEFAULT_TOOLS;
	const prompt = [
		ROK_CORE_PROMPT,
		`Available tools:\n${formatToolList(tools, options.toolSnippets)}`,
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		`Guidelines:\n${formatGuidelines(options.promptGuidelines)}`,
		formatPiDocsGuidance(),
		formatTauDocsGuidance(),
	];

	if (options.customPrompt) prompt.push(options.customPrompt);
	if (options.appendSystemPrompt) prompt.push(options.appendSystemPrompt);

	const context = formatProjectContext(options.contextFiles ?? []);
	if (context) prompt.push(context);

	const skills = formatSkillsForPrompt(options.skills ?? []).trim();
	if (skills) prompt.push(skills);
	prompt.push(formatRuntimeContext(runtimeContext));

	return prompt.join("\n\n");
}

export function freezeRuntimeContext(cwd: string): RuntimeContext {
	return { date: formatDate(new Date()), cwd: cwd.replace(/\\/g, "/"), rootSnapshot: listRootSnapshot(cwd) };
}

function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatRuntimeContext(context: RuntimeContext): string {
	const rootSnapshot = context.rootSnapshot.length
		? `\nRoot directory snapshot (depth 2):\n${context.rootSnapshot.map((path) => `- ${path}`).join("\n")}`
		: "";
	return `Current date: ${context.date}\nCurrent working directory: ${context.cwd}${rootSnapshot}`;
}

function listRootSnapshot(cwd: string): string[] {
	const root = resolve(cwd);
	const rootEntries = listSnapshotEntries(root, ".");
	const ignoredRootPaths = gitIgnoredPaths(
		root,
		rootEntries.map((entry) => entry.path),
	);
	const visibleRootEntries = rootEntries.filter(
		(entry) => !isAlwaysHiddenFromSnapshot(entry.dirent.name) && !ignoredRootPaths.has(entry.path),
	);
	const childEntriesByParent = new Map<string, SnapshotEntry[]>();
	const childPaths: string[] = [];

	for (const entry of visibleRootEntries) {
		if (!entry.dirent.isDirectory()) continue;
		const childEntries = listSnapshotEntries(root, entry.path).filter(
			(childEntry) => !isAlwaysHiddenFromSnapshot(childEntry.dirent.name),
		);
		childEntriesByParent.set(entry.path, childEntries);
		childPaths.push(...childEntries.map((childEntry) => childEntry.path));
	}

	const ignoredChildPaths = gitIgnoredPaths(root, childPaths);
	const paths: string[] = [];

	for (const entry of visibleRootEntries) {
		pushSnapshotPath(paths, entry);
		if (paths.length >= ROOT_SNAPSHOT_MAX_PATHS) break;

		for (const childEntry of childEntriesByParent.get(entry.path) ?? []) {
			if (ignoredChildPaths.has(childEntry.path)) continue;
			pushSnapshotPath(paths, childEntry);
			if (paths.length >= ROOT_SNAPSHOT_MAX_PATHS) break;
		}
	}

	return paths.length === ROOT_SNAPSHOT_MAX_PATHS ? [...paths, "..."] : paths;
}

function listSnapshotEntries(root: string, relativePath: string): SnapshotEntry[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, relativePath), { withFileTypes: true });
	} catch {
		return [];
	}

	return entries
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((dirent) => ({
			dirent,
			path: relativePath === "." ? dirent.name : `${relativePath}/${dirent.name}`,
		}));
}

function gitIgnoredPaths(root: string, paths: readonly string[]): Set<string> {
	if (paths.length === 0) return new Set();

	const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
		cwd: root,
		encoding: "utf8",
		input: `${paths.join("\0")}\0`,
	});

	if (result.status === 0 || result.status === 1) {
		return new Set(result.stdout.split("\0").filter(Boolean));
	}
	return new Set(paths.filter((path) => path.split("/").includes("node_modules")));
}

function isAlwaysHiddenFromSnapshot(name: string): boolean {
	return name === ".git";
}

function pushSnapshotPath(paths: string[], entry: SnapshotEntry): void {
	if (paths.length >= ROOT_SNAPSHOT_MAX_PATHS) return;
	paths.push(entry.dirent.isDirectory() ? `${entry.path}/` : entry.path);
}

function formatToolList(tools: readonly string[], snippets: Record<string, string> | undefined): string {
	const visible = tools.filter((name) => snippets?.[name]);
	return visible.length ? visible.map((name) => `- ${name}: ${snippets?.[name]}`).join("\n") : "(none)";
}

function formatGuidelines(guidelines: readonly string[] | undefined): string {
	const result: string[] = [];
	const seen = new Set<string>();
	const add = (guideline: string): void => {
		const normalized = guideline.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		result.push(normalized);
	};

	for (const guideline of guidelines ?? []) add(guideline);
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");

	return result.map((guideline) => `- ${guideline}`).join("\n");
}

function formatPiDocsGuidance(): string {
	return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
}

function formatTauDocsGuidance(): string {
	return `Tau Agent documentation (read only when the user asks about Tau Agent, Rok, Tau extensions, Tau event APIs, harness behavior, or extending Tau Agent):
- Tau Agent docs: ${getTauDocsPath()}
- For external Tau Agent integration, read docs/extending-tau-agent.md first
- Resolve Tau docs/... under Tau Agent docs, not the current working directory
- Do not read Tau Agent docs for normal coding tasks`;
}

function getTauDocsPath(): string {
	return join(resolveTauPackageRoot(), "docs");
}

function resolveTauPackageRoot(): string {
	const start = dirname(fileURLToPath(import.meta.url));
	for (let dir = start; ; dir = dirname(dir)) {
		const packagePath = join(dir, "package.json");
		if (existsSync(packagePath) && packageName(packagePath) === "tau-agent") return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
	}
	return resolve(start, "../../..");
}

function packageName(packagePath: string): string | undefined {
	try {
		const data: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
		if (!data || typeof data !== "object") return undefined;
		const name = (data as Record<string, unknown>).name;
		return typeof name === "string" ? name : undefined;
	} catch {
		return undefined;
	}
}

function formatProjectContext(contextFiles: readonly { path: string; content: string }[]): string {
	if (contextFiles.length === 0) return "";

	return [
		"<project_context>",
		"",
		"Project-specific instructions and modelines:",
		"",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
		"",
		"</project_context>",
	].join("\n");
}
