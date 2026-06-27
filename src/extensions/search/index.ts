import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { onTauEvent } from "../../shared/events.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { pruneSearchContext } from "./context-pruning.ts";
import { registerFindTool } from "./find.ts";
import { registerForgetTool } from "./forget.ts";
import { registerGrepTool } from "./grep.ts";
import { buildStartupWorkspaceMap, registerLsTool } from "./ls.ts";
import { AUTO_READ_CUSTOM_TYPE, PATH_UPDATE_CUSTOM_TYPE, textContent } from "./memory-messages.ts";
import { createMutationMemory } from "./mutation-memory.ts";
import { registerReadTool } from "./read.ts";
import { createSearchRenderState } from "./render-state.ts";
import searchSettings, { type SearchSettings } from "./settings.ts";

const MEMORY_GUIDANCE = [
	"Search working memory prunes only outbound model context; raw session history and /tree stay intact.",
	"Grep/find output is navigation evidence. After read captures current files, old navigation evidence can be outdated.",
	"Before final response after tool use, call forget for successful exploration that next turn does not need.",
	"Use forget disposition irrelevant for dead-end exploration and done for served-purpose exploration.",
	"After mutations, rely on auto read/path update evidence unless broader current context is required.",
];

export default function searchExtension(pi: ExtensionAPI): void {
	const renderState = createSearchRenderState();
	let settings: SearchSettings = searchSettings.defaults;
	let startupMapSent = false;
	const mutationMemory = createMutationMemory({ getSettings: () => settings });

	registerReadTool(pi, renderState);
	registerGrepTool(pi, renderState);
	registerFindTool(pi, renderState);
	registerLsTool(pi, renderState);
	registerForgetTool(pi, renderState, () => settings.workingMemory);
	registerMemoryRenderers(pi);

	const unsubscribeMutation = onTauEvent(pi, "tau:file-mutation.applied", (event) =>
		settings.workingMemory ? mutationMemory.sendMutationEvidence(pi, event) : undefined,
	);
	const unsubscribeSnapshot = onTauEvent(pi, "tau:context.snapshot", (event) =>
		settings.workingMemory ? mutationMemory.sendContextAutoReads(pi, event) : undefined,
	);

	pi.on("session_shutdown", () => {
		unsubscribeMutation();
		unsubscribeSnapshot();
	});

	pi.on("session_start", async (_event, ctx) => {
		settings = await loadSearchSettings(ctx);
		setForgetActive(pi, settings.workingMemory);
		if (!settings.workingMemory) return;
		const leafId = ctx.sessionManager.getLeafId();
		const { messages } = buildSessionContext(ctx.sessionManager.getBranch(), leafId);
		renderState.setStatuses(pruneSearchContext(messages, ctx.cwd).statuses);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const pieces = [event.systemPrompt];
		if (!startupMapSent) {
			startupMapSent = true;
			pieces.push(await buildStartupWorkspaceMap(ctx.cwd, ctx.signal));
		}
		if (settings.workingMemory)
			pieces.push(`Search working memory:\n${MEMORY_GUIDANCE.map((line) => `- ${line}`).join("\n")}`);
		return { systemPrompt: pieces.join("\n\n") };
	});

	pi.on("context", (event, ctx) => {
		if (!settings.workingMemory) return undefined;
		const result = pruneSearchContext(event.messages, ctx.cwd);
		renderState.setStatuses(result.statuses);
		return { messages: result.messages };
	});
}

async function loadSearchSettings(ctx: ExtensionContext): Promise<SearchSettings> {
	return loadTauExtensionSettings(ctx, searchSettings);
}

function setForgetActive(pi: ExtensionAPI, enabled: boolean): void {
	const active = pi.getActiveTools();
	if (enabled && !active.includes("forget")) pi.setActiveTools([...active, "forget"]);
	if (!enabled && active.includes("forget")) pi.setActiveTools(active.filter((name) => name !== "forget"));
}

function registerMemoryRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(
		AUTO_READ_CUSTOM_TYPE,
		(message, { expanded }, theme) => new MemoryMessageComponent("auto read", message, expanded, theme),
	);
	pi.registerMessageRenderer(
		PATH_UPDATE_CUSTOM_TYPE,
		(message, { expanded }, theme) => new MemoryMessageComponent("path update", message, expanded, theme),
	);
}

class MemoryMessageComponent implements Component {
	private readonly title: string;
	private readonly message: { content: unknown; details?: unknown };
	private readonly expanded: boolean;
	private readonly theme: Theme;

	constructor(title: string, message: { content: unknown; details?: unknown }, expanded: boolean, theme: Theme) {
		this.title = title;
		this.message = message;
		this.expanded = expanded;
		this.theme = theme;
	}
	render(): string[] {
		const header = this.theme.fg("toolTitle", this.theme.bold(this.title));
		if (!this.expanded) return [header];
		return `${header}\n${textContent(this.message.content) ?? ""}`.split("\n");
	}
	invalidate(): void {}
}
