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

- For an unfamiliar repository or subtree, use recursive \`outline\` when the active tool supports it. With a non-recursive \`outline\`, find a likely package first and outline that directory.
- Outline known packages or files before reading their source.
- Add exact \`names\` and set \`includePrivate\` when the likely declaration or internal surface is known.
- Use \`symbol(signatureWithDocs)\` for one documented contract without its implementation body. Use the other symbol views for exact declaration source, batching locators when useful.
- Use ordinary \`read\` for unsupported files and for source outside declaration boundaries after structural orientation.`;
}
