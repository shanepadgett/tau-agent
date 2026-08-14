import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPrimaryDirectiveOverseer } from "./overseer.ts";
import { CODE_STYLE, COMMUNICATION_STYLE, OPERATING_MODEL } from "./prompt.ts";

export default function soulExtension(pi: ExtensionAPI): void {
	registerPrimaryDirectiveOverseer(pi);
	pi.on("before_agent_start", (event) => ({
		systemPrompt: [event.systemPrompt, COMMUNICATION_STYLE, OPERATING_MODEL, CODE_STYLE].join("\n\n"),
	}));
}
