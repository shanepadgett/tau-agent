import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "explore",
	defaults: {
		context: {
			defaultBudgetTokens: 8000 as number,
		},
		read: {
			enabled: true as boolean,
			structureThresholdLines: 200 as number,
			maxRangeLines: 200 as number,
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
			read: Type.Optional(
				Type.Object(
					{
						enabled: Type.Optional(
							Type.Boolean({
								default: true,
								description:
									"Master switch for Explore structural read overlay and large-source autoread outline path. When false, Pi read and autoread keep ordinary full bodies.",
							}),
						),
						structureThresholdLines: Type.Optional(
							Type.Integer({
								default: 200,
								minimum: 1,
								description:
									"Registered source at or under this line count may be full-read. Above it, full read model-visible result is outline only.",
							}),
						),
						maxRangeLines: Type.Optional(
							Type.Integer({
								default: 200,
								minimum: 1,
								description: "Maximum lines returned by one ranged read on registered source.",
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
