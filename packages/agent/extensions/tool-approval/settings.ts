import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "toolApproval",
	defaults: {
		enabled: true as boolean,
		autoApprove: true as boolean,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(
				Type.Boolean({ default: true, description: "Enable tool request review and approval." }),
			),
			autoApprove: Type.Optional(
				Type.Boolean({
					default: true,
					description: "Run reviewer-approved tool requests without human confirmation.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
