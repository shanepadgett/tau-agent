import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "explore",
	defaults: {
		context: {
			defaultBudgetTokens: 8000 as number,
		},
	},
	schema: Type.Object(
		{
			context: Type.Optional(
				Type.Object(
					{
						defaultBudgetTokens: Type.Optional(
							Type.Integer({
								default: 8000,
								minimum: 1,
								description: "Default token budget for context when the caller omits budget.",
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
