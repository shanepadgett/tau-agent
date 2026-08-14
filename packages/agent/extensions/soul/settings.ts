import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

const DEFAULT_OVERSEER_TOOL_CALL_INTERVAL = 20;

export default defineTauExtensionSettings({
	key: "soul",
	defaults: {
		overseer: {
			enabled: true as boolean,
			toolCallInterval: DEFAULT_OVERSEER_TOOL_CALL_INTERVAL,
		},
	},
	schema: Type.Object(
		{
			overseer: Type.Object(
				{
					enabled: Type.Boolean({
						default: true,
						description: "Run hidden primary-directive reviews during long tool-using work.",
					}),
					toolCallInterval: Type.Integer({
						minimum: 1,
						maximum: 100,
						default: DEFAULT_OVERSEER_TOOL_CALL_INTERVAL,
						description: "Unreviewed tool calls required before the next primary-directive review.",
					}),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
});
