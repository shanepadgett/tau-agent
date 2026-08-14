import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 175_000;

export default defineTauExtensionSettings({
	key: "autoCompact",
	defaults: {
		tokenLimit: DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
	},
	schema: Type.Object(
		{
			tokenLimit: Type.Integer({
				minimum: 1,
				default: DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
				description: "Absolute context-token count that triggers compaction before the next model turn.",
			}),
		},
		{ additionalProperties: false },
	),
});
