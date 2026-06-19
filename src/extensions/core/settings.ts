import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "core",
	defaults: { soul: { enabled: true as boolean } },
	schema: Type.Object(
		{
			soul: Type.Optional(
				Type.Object(
					{
						enabled: Type.Optional(
							Type.Boolean({ default: true, description: "Enable Tau's Lyle system prompt replacement." }),
						),
					},
					{ additionalProperties: false, description: "Soul prompt settings." },
				),
			),
		},
		{ additionalProperties: false, description: "Tau core settings." },
	),
});
