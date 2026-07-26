import { relative, resolve } from "node:path";
import { Type } from "typebox";
import { matchGlob, posixPath } from "../../shared/glob.ts";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export interface ExploreReadGateSettings {
	includeGlobs: string[];
	excludeGlobs: string[];
}

export default defineTauExtensionSettings({
	key: "explore",
	defaults: {
		readGate: {
			includeGlobs: ["**/*"] as string[],
			excludeGlobs: ["**/*.md", "**/*.markdown", "**/*.mdown"] as string[],
		},
	},
	schema: Type.Object(
		{
			readGate: Type.Object(
				{
					includeGlobs: Type.Array(Type.String(), {
						default: ["**/*"],
						description:
							"Working-directory-relative supported source paths that require a structural attempt before read.",
					}),
					excludeGlobs: Type.Array(Type.String(), {
						default: ["**/*.md", "**/*.markdown", "**/*.mdown"],
						description: "Working-directory-relative paths excluded from the Explore read gate. Exclusions win.",
					}),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
});

export function matchesExploreReadGate(path: string, cwd: string, settings: ExploreReadGateSettings): boolean {
	const projectPath = posixPath(relative(resolve(cwd), resolve(path)));
	return (
		settings.includeGlobs.some((pattern) => matchGlob(pattern, projectPath)) &&
		!settings.excludeGlobs.some((pattern) => matchGlob(pattern, projectPath))
	);
}
