import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "context",
	defaults: {
		validation: {
			enabled: true as boolean,
			ignoreGlobs: [] as string[],
		},
	},
	schema: Type.Object(
		{
			validation: Type.Optional(
				Type.Object(
					{
						enabled: Type.Optional(
							Type.Boolean({ default: true, description: "Validate context membership after agent turns." }),
						),
						ignoreGlobs: Type.Optional(
							Type.Array(Type.String(), {
								default: [],
								description: "Project-relative files excluded from context membership validation and sync.",
							}),
						),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
});
