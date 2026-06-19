import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "soul",
	defaults: { enabled: true as boolean },
	schema: Type.Object(
		{
			enabled: Type.Optional(
				Type.Boolean({ default: true, description: "Enable Tau's Lyle system prompt replacement." }),
			),
		},
		{ additionalProperties: false },
	),
});
