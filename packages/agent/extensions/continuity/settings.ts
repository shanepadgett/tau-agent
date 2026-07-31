import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "continuity",
	defaults: {
		showToolRows: false as boolean,
	},
	schema: Type.Object(
		{
			showToolRows: Type.Optional(
				Type.Boolean({
					default: false,
					description: "Show continuity checkpoint and injected-file rows in the TUI for debugging.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
