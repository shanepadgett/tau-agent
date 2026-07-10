import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { buildRokPrompt, freezeRuntimeContext, type RuntimeContext } from "./prompt.ts";
import soulSettings from "./settings.ts";

export default function soulExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let runtimeContext: RuntimeContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		enabled = (await loadTauExtensionSettings(ctx, soulSettings)).enabled;
		runtimeContext = freezeRuntimeContext(ctx.cwd);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!enabled) return undefined;
		runtimeContext ??= freezeRuntimeContext(ctx.cwd);
		return { systemPrompt: buildRokPrompt(event.systemPromptOptions, runtimeContext) };
	});
}
