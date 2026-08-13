import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDANCE = `## Explore
Shape-backed languages: \`markdown\`, \`typescript\`, \`tsx\`, \`go\`, \`rust\`, \`c_sharp\`, \`java\`, \`kotlin\`, \`swift\`.

Structural tools (\`outline\`, \`show\`, \`discover\`, \`ast_search\`, deps/relationships, \`impact\`, \`context\`) apply to those languages. Other files: harness \`read\` / \`grep\` / \`find\` / \`ls\`.
Full \`read\` of a large registered source returns outline + follow-up hint, not the body — use ranged \`read\` or \`show\`.
\`show\` always takes a top-level \`targets\` array, even for one declaration: \`{"targets":[{"path":"...","name":"..."}],"view":"declaration"}\`.`;

export function registerExploreGuidance(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` }));
}
