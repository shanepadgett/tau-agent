import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export type ReferenceEditor = "default" | "code" | "zed";

export default defineTauExtensionSettings({
	key: "reference",
	defaults: { editor: "default" as ReferenceEditor, branchChoices: 5 as number },
	schema: Type.Object(
		{
			editor: Type.Optional(
				Type.Union([Type.Literal("default"), Type.Literal("code"), Type.Literal("zed")], {
					default: "default",
					description:
						"Editor used by the reference picker open action. default uses $VISUAL, $EDITOR, then code.",
				}),
			),
			branchChoices: Type.Optional(
				Type.Integer({
					default: 5,
					minimum: 1,
					maximum: 50,
					description: "Maximum branch choices shown when switching a reference branch.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
