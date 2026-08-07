import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "bashApproval",
	defaults: {
		enabled: true as boolean,
		autoApprove: false as boolean,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(
				Type.Boolean({ default: true, description: "Enable bash command review and approval." }),
			),
			autoApprove: Type.Optional(
				Type.Boolean({
					default: false,
					description: "Run recognized direct commands when the quick reviewer approves them.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
