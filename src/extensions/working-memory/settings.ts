import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export interface WorkingMemorySettings {
	excludedPaths: string[];
}

export default defineTauExtensionSettings({
	key: "working-memory",
	defaults: { excludedPaths: [] as string[] },
	schema: Type.Object(
		{
			excludedPaths: Type.Optional(
				Type.Array(
					Type.String({ description: "Paths or simple globs excluded from automatic working-memory rereads." }),
				),
			),
		},
		{ additionalProperties: false },
	),
});
