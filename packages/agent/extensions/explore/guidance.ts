import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExploreEngine } from "../../src/ast/engine.ts";
import { walkPaths } from "../../src/ast/traverse.ts";

const GUIDANCE_SCAN_MAX_ENTRIES = 4096;

export function registerExploreGuidance(pi: ExtensionAPI, engineFor: (cwd: string) => ExploreEngine): void {
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const engine = engineFor(ctx.cwd);
			const advertised = engine.registry
				.registeredLanguages()
				.filter((language) => language.capabilities.shape)
				.map((language) => language.id);
			const advertisedSet = new Set(advertised);
			const detected = new Set<string>();

			await walkPaths({
				cwd: engine.cwd,
				root: ".",
				filesOnly: true,
				budgets: { maxFiles: GUIDANCE_SCAN_MAX_ENTRIES },
				onFile(hit) {
					const language = engine.registry.adapterForPath(hit.absolutePath)?.id;
					if (language !== undefined && advertisedSet.has(language)) detected.add(language);
					return detected.size < advertisedSet.size;
				},
			});

			const backed = advertised.filter((language) => detected.has(language));
			if (backed.length === 0) return undefined;

			const guidance = `## Explore
Shape-backed in this workspace: ${backed.map((language) => `\`${language}\``).join(", ")}.

Structural tools (\`outline\`, \`show\`, \`discover\`, \`ast_search\`, deps/relationships, \`impact\`, \`context\`) apply to those languages. Other files: harness \`read\` / \`grep\` / \`find\` / \`ls\`.
Full \`read\` of a large registered source returns outline + follow-up hint, not the body — use ranged \`read\` or \`show\`.`;

			return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
		} catch {
			return undefined;
		}
	});
}
