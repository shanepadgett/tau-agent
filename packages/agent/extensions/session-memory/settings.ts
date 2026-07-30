import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "sessionMemory",
	defaults: {
		enabled: true as boolean,
		showToolRows: false as boolean,
		contextCeilingTokens: 150_000 as number,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true, description: "Enable session memory." })),
			showToolRows: Type.Optional(
				Type.Boolean({
					default: false,
					description: "Show session_memory tool rows for debugging.",
				}),
			),
			contextCeilingTokens: Type.Optional(
				Type.Integer({
					default: 150_000,
					minimum: 30_001,
					description: "Maximum active-context tokens before the fixed checkpoint reserve.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
