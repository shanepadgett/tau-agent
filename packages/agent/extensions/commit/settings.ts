import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export type CommitPushPolicy = boolean | "ask";

export default defineTauExtensionSettings({
	key: "commit",
	defaults: { push: "ask" as CommitPushPolicy },
	schema: Type.Object(
		{
			push: Type.Optional(
				Type.Union([Type.Boolean(), Type.Literal("ask")], {
					default: "ask",
					description:
						'Push after /commit: true pushes automatically, false never pushes or asks, "ask" prompts (default).',
				}),
			),
		},
		{ additionalProperties: false },
	),
});
