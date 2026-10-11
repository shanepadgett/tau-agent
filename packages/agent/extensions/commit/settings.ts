import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "commit",
	defaults: { push: false as boolean },
	schema: Type.Object(
		{
			push: Type.Optional(
				Type.Boolean({
					default: false,
					description: "Push automatically after /commit lands instead of asking.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
