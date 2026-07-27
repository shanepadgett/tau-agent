import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { CAVEMAN_STYLE, PONYTAIL_ETHOS } from "./prompt.ts";
import soulSettings from "./settings.ts";

export default function soulExtension(pi: ExtensionAPI): void {
	let ponytail = true;
	let caveman = true;

	pi.on("session_start", async (_event, ctx) => {
		const settings = await loadTauExtensionSettings(ctx, soulSettings);
		ponytail = settings.ponytail;
		caveman = settings.caveman;
	});

	pi.on("before_agent_start", (event) => {
		const sections: string[] = [];
		if (ponytail) sections.push(PONYTAIL_ETHOS);
		if (caveman) sections.push(CAVEMAN_STYLE);
		if (sections.length === 0) return undefined;
		return { systemPrompt: [event.systemPrompt, ...sections].join("\n\n") };
	});
}
