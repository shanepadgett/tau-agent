import {
	AST_LANGUAGE_REGISTRY,
	astLanguageForPath,
	formatAstLanguageLabels,
	type AstLanguage,
} from "./ast-languages.ts";
import { collectPaths } from "./traverse.ts";

export const AST_DISCOVERY_BUDGET = 4096;

export interface AstGuidanceRequest {
	cwd: string;
	workerLanguages(): Promise<readonly AstLanguage[]>;
	discoveryBudget: number;
}

export async function effectiveAstGuidance(request: AstGuidanceRequest): Promise<string | undefined> {
	let detected: Set<AstLanguage>;
	try {
		const entries = await collectPaths({
			cwd: request.cwd,
			root: request.cwd,
			maxEntries: request.discoveryBudget,
			includeRoot: false,
			includeHidden: true,
			includeIgnored: false,
			includeNoise: false,
		});
		detected = new Set(
			entries.flatMap((entry) => {
				if (entry.type !== "file") return [];
				const language = astLanguageForPath(entry.absolutePath);
				return language ? [language] : [];
			}),
		);
	} catch {
		return undefined;
	}

	if (detected.size === 0) return undefined;
	let workerLanguages: readonly AstLanguage[];
	try {
		workerLanguages = await request.workerLanguages();
	} catch {
		return undefined;
	}
	const available = new Set(workerLanguages);
	const languages = AST_LANGUAGE_REGISTRY.filter(
		(language) => detected.has(language.workerLanguage) && available.has(language.workerLanguage),
	);
	if (languages.length === 0) return undefined;
	const labels = formatAstLanguageLabels(languages, "and");
	return `## Explore source policy

AST-backed exploration is available here for ${labels}.

- Use the smallest structural query that can answer the current question. Stop when the result is sufficient; expand only for a specific unresolved question.
- Identify the current job before exploring: locate, reuse, edit, explain, or debug. Do not preload implementation, callers, tests, or documentation needed only by a later stage.
- For an unfamiliar repository or subtree, use recursive \`outline\` when available. Otherwise find a likely package, then outline that directory. For a known package or file, outline it directly.
- Outline large Markdown files first, then retrieve only the relevant heading section with \`symbol\`.
- For reuse work with an unknown location, use \`api_discover\` and prefer \`packageSurface\`, \`sourceExport\`, or \`public\` results. Inspect private declarations only when targeted implementation work requires them.
- Narrow paths, exact \`names\`, query work, and result limits as soon as the likely target is known.
- Treat a clear outline or API candidate signature as enough. Use \`symbol(signature)\` only when that selected contract needs closer inspection, \`signatureWithDocs\` only when attached documentation matters, and declaration views only for exact implementation source.
- Discover references, callers, implementations, and affected tests after selecting a change target and when that impact information can change the plan. Do not inspect tests up front unless the task starts from test behavior or a failure.
- Use \`ast_search\` for code shapes and \`grep\` for literal text. Use targeted \`read\` for exact formatting, comments, unsupported files, or source outside declaration boundaries.
- Prefer locator edits for a known declaration or body when they express the complete change cleanly. Use textual patching when the change crosses structural boundaries or depends on exact surrounding text.`;
}
