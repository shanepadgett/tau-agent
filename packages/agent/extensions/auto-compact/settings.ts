import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 175_000;

export default defineTauExtensionSettings({
	key: "autoCompact",
	defaults: {
		enabled: true as boolean,
		tokenLimit: DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(
				Type.Boolean({
					default: true,
					description: "Enable automatic compaction when context reaches the token limit.",
				}),
			),
			tokenLimit: Type.Optional(
				Type.Integer({
					minimum: 1,
					default: DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
					description: "Absolute context-token count that triggers compaction before the next model turn.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
