import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "soul",
	defaults: { ponytail: true as boolean, simplified: true as boolean },
	schema: Type.Object(
		{
			ponytail: Type.Optional(
				Type.Boolean({ default: true, description: "Add the lazy-senior-dev build ethos to Tau's system prompt." }),
			),
			simplified: Type.Optional(
				Type.Boolean({
					default: true,
					description: "Add Simplified Technical English and small-chunk explanations to Tau's system prompt.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
