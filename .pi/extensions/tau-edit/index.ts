import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { promptForDescription } from "../../../src/shared/description.ts";
import {
	clearEmittedInjectedContexts,
	clearPendingInjectedContexts,
	queueInjectedContext,
	shiftPendingInjectedContext,
} from "../../../src/shared/injected-context.ts";
import { pickReferences, type ReferenceItem, referenceLines } from "../../../src/shared/reference-picker.ts";
import {
	TabbedMultiSelect,
	type TabbedMultiSelectItem,
	type TabbedMultiSelectSelection,
	type TabbedMultiSelectTab,
} from "../../../src/shared/tui/tabbed-multi-select.ts";

type ResourceKind = "local-extension" | "tau-extension" | "prompt" | "theme" | "skill";

interface Resource {
	kind: ResourceKind;
	name: string;
	path: string;
}

const TAB_LABELS: Record<ResourceKind, string> = {
	"local-extension": "Local extensions",
	"tau-extension": "Tau extensions",
	prompt: "Prompts",
	theme: "Themes",
	skill: "Skills",
};

export default function tauEdit(pi: ExtensionAPI): void {
	pi.registerCommand("tau-edit", {
		description: "Pick Tau resources and inject their files as hidden context",
		handler: async (_args, ctx) => run(pi, ctx),
	});

	pi.on("before_agent_start", () => {
		const message = shiftPendingInjectedContext();
		return message ? { message } : undefined;
	});

	pi.on("agent_end", () => {
		clearEmittedInjectedContexts();
	});

	pi.on("session_shutdown", () => {
		clearPendingInjectedContexts();
	});
}

async function run(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/tau-edit requires TUI mode.", "error");
		return;
	}

	const resources = await discoverResources(ctx.cwd);
	const tabs = makeTabs(resources);
	if (!tabs.some((tab) => tab.items.length > 0)) {
		ctx.ui.notify("No Tau resources found.", "warning");
		return;
	}

	const selections = await ctx.ui.custom<TabbedMultiSelectSelection[] | undefined>(
		(_tui, theme, _keybindings, done) => new TabbedMultiSelect("Tau edit", tabs, theme, done),
	);
	if (!selections) return;
	if (selections.length === 0) {
		ctx.ui.notify("Select at least one resource.", "warning");
		return;
	}

	const byPath = new Map(resources.map((resource) => [resource.path, resource]));
	const selected = selections.flatMap((selection) => {
		const resource = byPath.get(selection.itemId);
		return resource ? [resource] : [];
	});

	const prompt = await promptForDescription(
		ctx,
		"Describe what you want to work on",
		"Description required: describe what you want to work on",
	);
	if (!prompt) return;
	const references = await getReferences(pi, ctx);
	if (references === null) return;

	queueInjectedContext(await buildContext(ctx.cwd, selected), { source: "tau-edit", title: "Tau edit context" });
	const message = buildMessage(prompt.text, prompt.source === "idea", references);
	if (ctx.isIdle()) pi.sendUserMessage(message);
	else pi.sendUserMessage(message, { deliverAs: "followUp" });
}

async function getReferences(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<ReferenceItem[] | null> {
	const choice = await ctx.ui.select("Attach reference repos?", ["no", "yes"]);
	if (choice === undefined) return null;
	if (choice !== "yes") return [];
	return (await pickReferences(pi, ctx)) ?? null;
}

async function discoverResources(cwd: string): Promise<Resource[]> {
	return [
		...(await discoverExtensionEntries(cwd, ".pi/extensions", "local-extension")),
		...(await discoverExtensionEntries(cwd, "src/extensions", "tau-extension")),
		...(await discoverFiles(cwd, ["prompts", ".pi/prompts"], ".md", "prompt")),
		...(await discoverFiles(cwd, ["themes", ".pi/themes"], ".json", "theme")),
		...(await discoverSkills(cwd, ["skills", ".pi/skills"])),
	].sort((a, b) => TAB_LABELS[a.kind].localeCompare(TAB_LABELS[b.kind]) || a.name.localeCompare(b.name));
}

async function discoverExtensionEntries(cwd: string, root: string, kind: ResourceKind): Promise<Resource[]> {
	const entries = await safeReaddir(join(cwd, root));
	return entries
		.filter((entry) => (entry.isDirectory() || entry.name.endsWith(".ts")) && !entry.name.startsWith("."))
		.map((entry) => ({
			kind,
			name: entry.isDirectory() ? entry.name : entry.name.slice(0, -extname(entry.name).length),
			path: `${root}/${entry.name}`,
		}));
}

async function discoverFiles(cwd: string, roots: string[], suffix: string, kind: ResourceKind): Promise<Resource[]> {
	const resources: Resource[] = [];
	for (const root of roots) {
		for (const path of await listFiles(cwd, root)) {
			if (!path.endsWith(suffix)) continue;
			resources.push({ kind, name: basename(path, suffix), path });
		}
	}
	return resources;
}

async function discoverSkills(cwd: string, roots: string[]): Promise<Resource[]> {
	const resources: Resource[] = [];
	for (const root of roots) {
		const entries = await safeReaddir(join(cwd, root));
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const path = `${root}/${entry.name}`;
			if (entry.isDirectory() && (await exists(join(cwd, path, "SKILL.md"))))
				resources.push({ kind: "skill", name: entry.name, path });
			else if (entry.isFile() && entry.name.endsWith(".md"))
				resources.push({ kind: "skill", name: basename(entry.name, ".md"), path });
		}
	}
	return resources;
}

function makeTabs(resources: Resource[]): TabbedMultiSelectTab[] {
	return (Object.keys(TAB_LABELS) as ResourceKind[]).map((kind) => ({
		id: kind,
		label: TAB_LABELS[kind],
		items: resources.filter((resource) => resource.kind === kind).map(resourceToItem),
	}));
}

function resourceToItem(resource: Resource): TabbedMultiSelectItem {
	return { id: resource.path, label: resource.name };
}

async function buildContext(cwd: string, resources: Resource[]): Promise<string> {
	const rootFiles = await listRootFiles(cwd);
	const sharedFiles = resources.some((resource) => resource.kind.endsWith("extension"))
		? await listFiles(cwd, "src/shared")
		: [];
	const resourceBlocks = await Promise.all(resources.map((resource) => renderResource(cwd, resource)));

	return [
		"Tau context:",
		"",
		"Root files:",
		...rootFiles.map((path) => `- ${path}`),
		...(sharedFiles.length > 0 ? ["", "Shared files:", ...sharedFiles.map((path) => `- ${path}`)] : []),
		"",
		"Selected resources:",
		resourceBlocks.join("\n\n"),
	].join("\n");
}

function buildMessage(request: string, fromIdea: boolean, references: readonly ReferenceItem[]): string {
	const refs = referenceLines(references);

	return [
		"# /tau-edit request",
		"",
		"Selected Tau resource files are injected as hidden context. Treat those file contents as current and authoritative. Do not reread injected files unless you edited them, the user says they changed, or needed content is missing from context.",
		"",
		"Root/shared files are injected as file names only. Read them only when this request directly requires their contents; do not read them for discovery.",
		"",
		...(fromIdea
			? [
					"This request is from an idea. After completing it, ask whether to remove the completed idea from .pi/tau/ideas.jsonl.",
					"",
				]
			: []),
		...(refs.length > 0 ? [...refs, ""] : []),
		"Request:",
		request,
	].join("\n");
}

async function renderResource(cwd: string, resource: Resource): Promise<string> {
	const files = await listResourceFiles(cwd, resource.path);
	const blocks = await Promise.all(
		files.map(async (path) => {
			const content = await readFile(join(cwd, path), "utf8");
			return `File: ${path}
${fencedFileContent(path, content)}`;
		}),
	);

	return [
		`Resource: ${resource.name}`,
		`Kind: ${resource.kind}`,
		`Path: ${resource.path}`,
		"",
		blocks.join("\n\n"),
	].join("\n");
}

async function listResourceFiles(cwd: string, path: string): Promise<string[]> {
	const absolute = join(cwd, path);
	const info = await stat(absolute);
	if (info.isFile()) return [path];
	return listFiles(cwd, path);
}

async function listRootFiles(cwd: string): Promise<string[]> {
	const entries = await safeReaddir(cwd);
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
}

async function listFiles(cwd: string, root: string): Promise<string[]> {
	const entries = await safeReaddir(join(cwd, root));
	const files: string[] = [];
	for (const entry of entries) {
		const path = `${root}/${entry.name}`;
		if (entry.isDirectory()) files.push(...(await listFiles(cwd, path)));
		else if (entry.isFile()) files.push(path);
	}
	return files.sort((a, b) => a.localeCompare(b));
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function safeReaddir(path: string) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function fencedFileContent(path: string, content: string): string {
	const fence = "`".repeat(Math.max(4, ...[...content.matchAll(/`+/g)].map((match) => match[0].length + 1)));
	return `${fence}${extname(path).slice(1)}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`;
}
