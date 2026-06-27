import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export interface SearchSettings {
	workingMemory: boolean;
	excludedPaths: string[];
}

export default defineTauExtensionSettings({
	key: "search",
	defaults: { workingMemory: true, excludedPaths: [] as string[] },
	schema: Type.Object(
		{
			workingMemory: Type.Optional(
				Type.Boolean({ description: "Enable search working-memory pruning and forget." }),
			),
			excludedPaths: Type.Optional(
				Type.Array(
					Type.String({ description: "Paths or simple globs excluded from automatic search auto reads." }),
				),
			),
		},
		{ additionalProperties: false },
	),
});
