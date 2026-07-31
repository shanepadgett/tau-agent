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

			const guidance = `## Explore source policy
Structurally backed languages detected in this workspace: ${backed.map((language) => `\`${language}\``).join(", ")}.

- Use the same workflow for every backed language. Identify the job type before loading deeply: locate, reuse, edit, explain, or debug.
- Ask the smallest sufficient query and stop when it answers the question.
- Prefer \`outline\` for unfamiliar trees and known packages. A large full harness \`read\` returns an outline; use ranged \`read\` or \`show\` for bodies.
- Prefer \`discover\` when reuse is the goal and the path is unknown. Search package/public surfaces first.
- Bind targets with path + name (+ line when needed). Use \`show\` views cheapest to richest: \`signature\`, \`signatureWithDocs\`, \`declaration\`, \`declarationWithImports\`.
- Run \`impact\` before a non-trivial symbol change. Use \`context\` to understand one symbol in one bounded pack.
- After selecting a target, use \`callers\`, \`callees\`, \`references\`, or \`implementations\` for focused relationship questions.
- Use \`ast_search\` for code shapes and harness \`grep\` for literals. Use harness \`read\` for formatting, comments, gaps, and unsupported files.
- List and search paths with harness \`ls\`, \`find\`, and \`grep\`. Edit only with harness patch/edit/write tools.
- Trust structural hits as exact path, line, and source text. Do not ask for scores or engine metadata.`;

			return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
		} catch {
			return undefined;
		}
	});
}
