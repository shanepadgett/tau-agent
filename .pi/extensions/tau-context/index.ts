import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { emitTauEvent } from "../../../src/shared/events.ts";
import { INJECTED_CONTEXT_TYPE } from "../../../src/shared/injected-context.ts";
import { bindingHint } from "../../../src/shared/tui/key-hints.ts";
import { SelectableList } from "../../../src/shared/tui/selectable-list.ts";
import { Tabs } from "../../../src/shared/tui/tabs.ts";
import { ToolPanel, type ToolPanelConfig } from "../../../src/shared/tui/tool-panel.ts";

type ResourceKind = "local-extension" | "tau-extension" | "prompt" | "theme" | "skill";

interface Resource {
	id: string;
	kind: ResourceKind;
	name: string;
	path: string;
}

interface ContextFile {
	path: string;
}

interface ResourceContext {
	manifest: string;
	files: ContextFile[];
}

const TAB_LABELS: Record<ResourceKind, string> = {
	"local-extension": "Local extensions",
	"tau-extension": "Tau extensions",
	prompt: "Prompts",
	theme: "Themes",
	skill: "Skills",
};
const RESOURCE_KINDS = Object.keys(TAB_LABELS) as ResourceKind[];

export default function tauContext(pi: ExtensionAPI): void {
	pi.registerCommand("tau-context", {
		description: "Pick Tau resources and prepare context",
		handler: async (_args, ctx) => run(pi, ctx),
	});
}

async function run(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/tau-context requires TUI mode.", "error");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("/tau-context requires an idle agent.", "error");
		return;
	}

	const resources = await discoverResources(ctx.cwd);
	if (resources.length === 0) {
		ctx.ui.notify("No Tau resources found.", "warning");
		return;
	}

	const selected = await ctx.ui.custom<Resource[] | undefined>(
		(_tui, theme, _keybindings, done) => new TauContextPanel(theme, resources, done),
	);
	if (!selected) return;
	if (selected.length === 0) {
		ctx.ui.notify("Select at least one resource.", "warning");
		return;
	}

	const context = await buildContext(ctx.cwd, selected);
	const batchId = randomUUID();
	pi.sendMessage({
		customType: INJECTED_CONTEXT_TYPE,
		content: context.manifest,
		display: false,
		details: { source: "tau-context", title: "Tau context" },
	});
	emitTauEvent(pi, "tau:autoread.requested", {
		source: "tau-context",
		title: "Tau context",
		cwd: ctx.cwd,
		batchId,
		files: context.files,
	});
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
			id: `${root}/${entry.name}`,
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
			resources.push({ id: path, kind, name: basename(path, suffix), path });
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
				resources.push({ id: path, kind: "skill", name: entry.name, path });
			else if (entry.isFile() && entry.name.endsWith(".md"))
				resources.push({ id: path, kind: "skill", name: basename(entry.name, ".md"), path });
		}
	}
	return resources;
}

async function buildContext(cwd: string, resources: Resource[]): Promise<ResourceContext> {
	const rootFiles = await listRootFiles(cwd);
	const sharedFiles = resources.some((resource) => resource.kind.endsWith("extension"))
		? await listFiles(cwd, "src/shared")
		: [];
	const resourcesContext = await Promise.all(resources.map((resource) => renderResource(cwd, resource)));
	const filesByPath = new Map<string, ContextFile>();
	for (const file of resourcesContext.flatMap((resource) => resource.files)) filesByPath.set(file.path, file);

	const manifest = [
		"# /tau-context",
		"",
		"Autoread files are visible context items in this conversation.",
		"Do not reread autoread files before answering questions or making changes.",
		"",
		"Root files are pointers only. Read only when directly needed.",
		"",
		"Root files:",
		...rootFiles.map((path) => `- ${path}`),
		"",
		"Shared files are pointers only. Read only when directly needed.",
		"",
		"Shared files:",
		...sharedFiles.map((path) => `- ${path}`),
		"",
		"Selected resources:",
		...resourcesContext.map((resource) => resource.manifest),
	].join("\n");

	return { manifest, files: [...filesByPath.values()] };
}

async function renderResource(cwd: string, resource: Resource): Promise<ResourceContext> {
	const files = await listResourceFiles(cwd, resource.path);

	return {
		manifest: `- ${resource.name} (${resource.kind}): ${resource.path}`,
		files: files.map((path) => ({ path })),
	};
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

class TauContextPanel implements Component {
	private readonly tabs: Tabs;
	private readonly panel: ToolPanel;
	private readonly panelConfig: ToolPanelConfig;
	private readonly done: (result: Resource[] | undefined) => void;
	private readonly listByKind = new Map<ResourceKind, SelectableList<Resource>>();
	private readonly selectedByKind = new Map<ResourceKind, readonly Resource[]>();

	constructor(theme: Theme, resources: readonly Resource[], done: (result: Resource[] | undefined) => void) {
		this.done = done;
		const itemsByKind = new Map(
			RESOURCE_KINDS.map((kind) => [kind, resources.filter((resource) => resource.kind === kind)]),
		);
		this.tabs = new Tabs(
			theme,
			RESOURCE_KINDS.map((kind) => {
				const items = itemsByKind.get(kind) ?? [];
				const list = new SelectableList(theme, {
					items,
					emptyMessage: "No items",
					selection: { kind: "multi" },
					filter: { searchText: (resource) => `${resource.name} ${resource.path}` },
					actions: [],
					maxVisible: 12,
					renderItem: (resource, state, width) => [
						truncateToWidth(state.active ? theme.bold(resource.name) : resource.name, width, ""),
					],
					onResult: () => {},
					onSelectionChange: (selected) => this.selectedByKind.set(kind, selected),
				});
				this.listByKind.set(kind, list);
				return {
					id: kind,
					label: TAB_LABELS[kind],
					count: items.length,
					body: list,
					getKeyHints: () => list.getKeyHints(),
				};
			}),
			"local-extension",
		);
		this.panelConfig = {
			title: "Tau context",
			secondary: "Select Tau resources to inject as autoread context.",
			body: this.tabs,
			footer: { kind: "hints", hints: this.footerHints() },
		};
		this.panel = new ToolPanel(theme, this.panelConfig);
	}

	handleInput(data: string): void {
		const activeList = this.activeList();
		if (activeList?.isFilterFocused()) {
			this.tabs.handleInput(data);
			this.syncFooter();
			return;
		}

		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.done(RESOURCE_KINDS.flatMap((kind) => [...(this.selectedByKind.get(kind) ?? [])]));
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		this.tabs.handleInput(data);
		this.syncFooter();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	private syncFooter(): void {
		this.panelConfig.footer = { kind: "hints", hints: this.footerHints() };
	}

	private footerHints() {
		const activeList = this.activeList();
		if (activeList?.isFilterFocused()) return activeList.getKeyHints();
		return [
			...this.tabs.getKeyHints(),
			bindingHint("tui.select.confirm", "submit"),
			bindingHint("tui.select.cancel", "cancel"),
		];
	}

	private activeList(): SelectableList<Resource> | undefined {
		return this.listByKind.get(this.tabs.getActiveId() as ResourceKind);
	}
}
