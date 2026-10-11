import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "compaction",
	defaults: {
		selfCompact: { enabled: true as boolean, noticeTokens: 100000, warningTokens: 150000, forcedTokens: 200000 },
	},
	schema: Type.Object(
		{
			selfCompact: Type.Optional(
				Type.Object(
					{
						enabled: Type.Optional(Type.Boolean({ default: true })),
						noticeTokens: Type.Optional(Type.Integer({ minimum: 1, default: 100000 })),
						warningTokens: Type.Optional(Type.Integer({ minimum: 2, default: 150000 })),
						forcedTokens: Type.Optional(Type.Integer({ minimum: 3, default: 200000 })),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
});
