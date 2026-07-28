import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "subagent",
	defaults: { disabled: [] as string[] },
	schema: Type.Object(
		{
			disabled: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					default: [],
					description: "Agent names unavailable for delegation.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
