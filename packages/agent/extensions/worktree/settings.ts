import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "worktree",
	defaults: { setupCommand: "" as string },
	schema: Type.Object(
		{
			setupCommand: Type.Optional(
				Type.String({
					default: "",
					description:
						"Shell command run inside each new worktree before its chat opens, for example npm ci --ignore-scripts. Empty runs nothing.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
