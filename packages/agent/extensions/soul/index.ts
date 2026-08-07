import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { PONYTAIL_ETHOS, SIMPLIFIED_TECHNICAL_ENGLISH } from "./prompt.ts";
import soulSettings from "./settings.ts";

export default function soulExtension(pi: ExtensionAPI): void {
	let ponytail = true;
	let simplified = true;

	pi.on("session_start", async (_event, ctx) => {
		const settings = await loadTauExtensionSettings(ctx, soulSettings);
		ponytail = settings.ponytail;
		simplified = settings.simplified;
	});

	pi.on("before_agent_start", (event) => {
		const sections: string[] = [];
		if (ponytail) sections.push(PONYTAIL_ETHOS);
		if (simplified) sections.push(SIMPLIFIED_TECHNICAL_ENGLISH);
		if (sections.length === 0) return undefined;
		return { systemPrompt: [event.systemPrompt, ...sections].join("\n\n") };
	});
}
