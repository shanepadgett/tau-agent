import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

const DEFAULT_NUDGE_INSTRUCTIONS: [string, ...string[]] = [
	"No prune is required yet unless broad exploration has converged or substantial evidence is already irrelevant. Continue coherent work.",
	"Move toward a pruning point now. Finish the current coherent step, then prune before starting another broad exploration. Managed context is materially increasing model cost.",
	"Prune now before further tool work. Continuing with stale managed context is wasting money.",
];

export default defineTauExtensionSettings({
	key: "contextPruning",
	defaults: {
		enabled: true as boolean,
		nudgeEveryPercent: 20 as number,
		nudgeInstructions: DEFAULT_NUDGE_INSTRUCTIONS,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true, description: "Enable context pruning." })),
			nudgeEveryPercent: Type.Optional(
				Type.Integer({
					default: 20,
					minimum: 1,
					maximum: 100,
					description: "Context growth interval between automatic pruning hints.",
				}),
			),
			nudgeInstructions: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
					default: DEFAULT_NUDGE_INSTRUCTIONS,
					minItems: 1,
					maxItems: 5,
					description:
						"Ordered automatic pruning instructions. Later reminders repeat the final instruction, and the final tier requires an anchor before further tool work.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
