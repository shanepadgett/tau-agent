import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";

const GUIDANCE = `## Explore
Shape-backed languages: \`markdown\`, \`typescript\`, \`tsx\`, \`go\`, \`rust\`, \`c_sharp\`, \`java\`, \`kotlin\`, \`swift\`.

Structural tools (\`outline\`, \`show\`, \`discover\`, \`ast_search\`, deps/relationships, \`impact\`, \`context\`) apply to those languages. Other files: harness \`read\` / \`grep\` / \`find\` / \`ls\`.
Full \`read\` of a large registered source returns outline + follow-up hint, not the body — use ranged \`read\` or \`show\`.
\`show\` always takes a top-level \`targets\` array, even for one declaration: \`{"targets":[{"path":"...","name":"..."}],"view":"declaration"}\`.`;

export function registerExploreGuidance(pi: ExtensionAPI): void {
	registerPromptSource(pi, {
		key: "explore/guidance",
		section: "tool-guidance",
		refresh: "compaction",
		async read() {
			return GUIDANCE;
		},
	});
}
