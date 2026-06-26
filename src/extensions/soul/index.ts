import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTauFooterItem } from "../../shared/events.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import {
	deriveActiveMode,
	filterModeMessages,
	modes,
	registerModeCommands,
	registerModeMessageRenderers,
} from "./modes/index.ts";
import { buildRokPrompt, freezeRuntimeContext, type RuntimeContext } from "./prompt.ts";
import soulSettings from "./settings.ts";

const FOOTER_ID = "tau-soul-mode";

export default function soulExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let runtimeContext: RuntimeContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		enabled = (await loadTauExtensionSettings(ctx, soulSettings)).enabled;
		runtimeContext = freezeRuntimeContext(ctx.cwd);
		updateFooter(pi, enabled ? deriveActiveMode(ctx.sessionManager.getBranch())?.verb : undefined);
	});

	pi.on("session_tree", (_event, ctx) => {
		updateFooter(pi, enabled ? deriveActiveMode(ctx.sessionManager.getBranch())?.verb : undefined);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!enabled) return undefined;
		runtimeContext ??= freezeRuntimeContext(ctx.cwd);
		return { systemPrompt: buildRokPrompt(event.systemPromptOptions, runtimeContext) };
	});

	pi.on("context", (event, ctx) => {
		if (!enabled) return undefined;
		const active = deriveActiveMode(ctx.sessionManager.getBranch());
		return { messages: filterModeMessages(event.messages, active) };
	});

	registerModeCommands(
		pi,
		modes,
		() => enabled,
		(verb) => updateFooter(pi, verb),
	);
	registerModeMessageRenderers(pi);
}

function updateFooter(pi: ExtensionAPI, verb: string | undefined): void {
	setTauFooterItem(pi, { id: FOOTER_ID, text: verb, priority: 100 });
}
