import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";

const GUIDANCE = `## Web research
Use \`websearch\` and \`webfetch\` through code mode scripts. Only what the script prints reaches context, so extract just the fields you need and leave raw result sets and pages in the script.
Batch every query and URL you already know into the same script.`;

export function registerWebGuidance(pi: ExtensionAPI): void {
	registerPromptSource(pi, {
		key: "web/guidance",
		section: "tool-guidance",
		refresh: "append",
		async read() {
			if (!pi.getActiveTools().includes("codemode")) return "";
			return GUIDANCE;
		},
	});
}
