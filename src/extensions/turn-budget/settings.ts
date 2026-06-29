import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "turnBudget",
	defaults: {
		enabled: true as boolean,
		turnLimit: 30 as number,
		nudgeEveryTurns: 5 as number,
		softCapIncrement: 10 as number,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true, description: "Enable turn-budget hints." })),
			turnLimit: Type.Optional(
				Type.Integer({
					default: 30,
					minimum: 1,
					description: "Initial soft cap for tool-using turns per user prompt.",
				}),
			),
			nudgeEveryTurns: Type.Optional(
				Type.Integer({
					default: 5,
					minimum: 1,
					description: "Tool-using turn interval between turn-budget hints.",
				}),
			),
			softCapIncrement: Type.Optional(
				Type.Integer({ default: 10, minimum: 1, description: "Turns added when the soft cap is reached." }),
			),
		},
		{ additionalProperties: false },
	),
});
