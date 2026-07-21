import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "contextPruning",
	defaults: {
		enabled: true as boolean,
		nudgeEveryPercent: 20 as number,
		pressurePercent: 50 as number,
		minimumReclaimTokens: 8000 as number,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true, description: "Enable context pruning." })),
			nudgeEveryPercent: Type.Optional(
				Type.Integer({
					default: 20,
					minimum: 1,
					maximum: 100,
					description: "Context growth interval between automatic pruning hints.",
				}),
			),
			pressurePercent: Type.Optional(
				Type.Integer({
					default: 50,
					minimum: 1,
					maximum: 99,
					description: "Context usage above which pruning hints become urgent.",
				}),
			),
			minimumReclaimTokens: Type.Optional(
				Type.Integer({
					default: 8000,
					minimum: 1,
					description: "Minimum estimated tokens a prune must reclaim.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
