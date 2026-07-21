import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export default defineTauExtensionSettings({
	key: "context",
	defaults: {
		sync: {
			enabled: true as boolean,
			automation: true as boolean,
		},
		validation: {
			enabled: false as boolean,
			ignoreGlobs: [] as string[],
		},
	},
	schema: Type.Object(
		{
			sync: Type.Optional(
				Type.Object(
					{
						enabled: Type.Optional(
							Type.Boolean({
								default: true,
								description:
									"Master switch for context-sync. When false: no /context-sync, parent cannot call the agent, validation does not auto-run sync.",
							}),
						),
						automation: Type.Optional(
							Type.Boolean({
								default: true,
								description:
									"When true with sync.enabled, the coding agent may call context-sync. When false, only manual /context-sync (validation auto-run still allowed if validation.enabled).",
							}),
						),
					},
					{ additionalProperties: false },
				),
			),
			validation: Type.Optional(
				Type.Object(
					{
						enabled: Type.Optional(
							Type.Boolean({
								default: false,
								description:
									"Validate context membership after agent turns and auto-run context-sync on failure (requires sync.enabled).",
							}),
						),
						ignoreGlobs: Type.Optional(
							Type.Array(Type.String(), {
								default: [],
								description: "Project-relative files excluded from context membership validation and sync.",
							}),
						),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
});
