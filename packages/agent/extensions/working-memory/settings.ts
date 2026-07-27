import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

const DEFAULT_NUDGE_INSTRUCTIONS: [string, ...string[]] = [
	"Reassess working memory. Continue coherent exploration when its evidence remains useful; otherwise prune known dead ends, obsolete outputs, and other context with no expected value.",
	"Context is materially larger. Prune stale or bulky irrelevant evidence when safe, but keep active working evidence that would otherwise need to be reread.",
	"Strongly reassess before more broad work. Remove accumulated waste and carry useful information at cheapest sufficient fidelity without scrubbing the active working set.",
];

export default defineTauExtensionSettings({
	key: "workingMemory",
	defaults: {
		enabled: true as boolean,
		nudgeEveryTokens: 40_000 as number,
		nudgeInstructions: DEFAULT_NUDGE_INSTRUCTIONS,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true, description: "Enable working-memory checkpoints." })),
			nudgeEveryTokens: Type.Optional(
				Type.Integer({
					default: 40_000,
					minimum: 1,
					description: "Active-context token interval between advisory working-memory reminders.",
				}),
			),
			nudgeInstructions: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
					default: DEFAULT_NUDGE_INSTRUCTIONS,
					minItems: 1,
					maxItems: 5,
					description: "Ordered advisory working-memory instructions. Later reminders repeat final instruction.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
