import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";
import { DEFAULT_CHECKPOINT_TOKEN_LIMIT } from "./checkpoint-budget.ts";

export default defineTauExtensionSettings({
	key: "continuity",
	defaults: {
		showToolRows: false as boolean,
		checkpointTokenLimit: DEFAULT_CHECKPOINT_TOKEN_LIMIT,
	},
	schema: Type.Object(
		{
			showToolRows: Type.Optional(
				Type.Boolean({
					default: false,
					description: "Show continuity checkpoint and injected-file rows in the TUI for debugging.",
				}),
			),
			checkpointTokenLimit: Type.Integer({
				minimum: 1,
				default: DEFAULT_CHECKPOINT_TOKEN_LIMIT,
				description: "Context-token ceiling before continuity requires a checkpoint.",
			}),
		},
		{ additionalProperties: false },
	),
});
