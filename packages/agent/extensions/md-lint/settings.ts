import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

const DEFAULT_IGNORE_GLOBS = [
	".git/**",
	"node_modules/**",
	"dist/**",
	"build/**",
	"coverage/**",
	"out/**",
	".cache/**",
	".next/**",
	".turbo/**",
	".parcel-cache/**",
	".pi/sessions/**",
	".pi/cache/**",
	".pi/tmp/**",
	".pi/temp/**",
	".pi/logs/**",
];

export default defineTauExtensionSettings({
	key: "mdLint",
	defaults: {
		enabled: true as boolean,
		ignoreGlobs: [...DEFAULT_IGNORE_GLOBS] as string[],
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true, description: "Enable automatic Markdown formatting." })),
			ignoreGlobs: Type.Optional(
				Type.Array(Type.String({ description: "Project-relative Markdown path to ignore." }), {
					default: [...DEFAULT_IGNORE_GLOBS],
					description: "Markdown files ignored by automatic formatting.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
