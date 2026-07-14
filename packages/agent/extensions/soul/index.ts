import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { ROK_SOUL } from "./prompt.ts";
import soulSettings from "./settings.ts";

export default function soulExtension(pi: ExtensionAPI): void {
	let enabled = true;

	pi.on("session_start", async (_event, ctx) => {
		enabled = (await loadTauExtensionSettings(ctx, soulSettings)).enabled;
	});

	pi.on("before_agent_start", (event) => {
		if (!enabled) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${ROK_SOUL}` };
	});
}
