import { Type } from "typebox";
import { defineTauExtensionSettings } from "../settings/define.ts";

export default defineTauExtensionSettings({
	key: "modelFallback",
	defaults: { cooldowns: {} },
	schema: Type.Object(
		{
			cooldowns: Type.Optional(
				Type.Record(
					Type.String(),
					Type.Number({ description: "Unix epoch milliseconds when the provider becomes available again." }),
				),
			),
		},
		{ additionalProperties: false },
	),
});
