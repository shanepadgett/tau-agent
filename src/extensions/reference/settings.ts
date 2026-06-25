import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export type ReferenceEditor = "default" | "code" | "zed";

export default defineTauExtensionSettings({
	key: "reference",
	defaults: { editor: "default" as ReferenceEditor },
	schema: Type.Object(
		{
			editor: Type.Optional(
				Type.Union([Type.Literal("default"), Type.Literal("code"), Type.Literal("zed")], {
					default: "default",
					description:
						"Editor used by the reference picker open action. default uses $VISUAL, $EDITOR, then code.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
