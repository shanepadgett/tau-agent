import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export interface RouteCandidate {
	provider: "openai-codex" | "anthropic";
	model: string;
	thinking: ThinkingLevel;
}

interface Route {
	description: string;
	candidates: RouteCandidate[];
}

const sonnet: RouteCandidate = { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "high" };
const opus: RouteCandidate = { provider: "anthropic", model: "claude-opus-5-5", thinking: "high" };
const routes: Record<
	"quick" | "general" | "frontend" | "simple-design" | "complex-design" | "writing" | "architecture",
	Route
> = {
	quick: {
		description:
			"Bounded work using existing patterns: repository questions, behavior checks, focused research and explanations, routine debugging, clear fixes, configuration changes, local refactors, and planning small changes. Read-only questions belong here when answering requires a narrow inspection rather than deep investigation. Several files or a few clarifying questions do not by themselves make the work difficult.",
		candidates: [
			{ provider: "openai-codex", model: "gpt-6-luna", thinking: "max" },
			{ provider: "anthropic", model: "claude-haiku-5-5", thinking: "high" },
		],
	},
	general: {
		description:
			"Substantial non-frontend engineering: difficult debugging, cross-system investigation and implementation, migrations, architecture tradeoffs, and planning with significant dependencies or uncertainty. Ordinary architecture and implementation planning belong here, not in exceptional architecture. Excludes bounded questions and clear changes using existing patterns.",
		candidates: [{ provider: "openai-codex", model: "gpt-6.1-sol", thinking: "high" }, sonnet],
	},
	frontend: {
		description:
			"Frontend implementation, accessibility, responsive behavior, and UI integration using established patterns. Includes whole pages assembled within an existing design system. Prefer this over general when frontend implementation is the main work.",
		candidates: [sonnet],
	},
	"simple-design": {
		description:
			"UI design and redesign within established patterns: components, controls, dialogs, related elements, and whole pages using an existing design system. Includes creative ideation, alternatives, mockups, visual refinement, and local new interactions. Page size, novelty, and requests to be creative do not alone justify exceptional design work.",
		candidates: [sonnet],
	},
	"complex-design": {
		description:
			"Exceptional UI design requiring substantial invention: establishing a new design system, fundamentally new interaction models, tightly coupled multi-screen workflows with unresolved interaction design, or explicitly exceptional creative ambition with substantial open-ended scope. Requires clear evidence of these demands; ordinary page design, multi-screen implementation within established patterns, and generic requests for creativity do not qualify.",
		candidates: [opus],
	},
	writing: {
		description:
			"Substantial prose, docs, and wording work. Brief factual explanations and focused summaries belong in quick.",
		candidates: [{ ...sonnet, thinking: "medium" }],
	},
	architecture: {
		description:
			"Exceptional software architecture with major unresolved constraints, tightly coupled unfamiliar systems, or high-consequence decisions requiring extensive tradeoff analysis. Requires clear evidence of exceptional difficulty; ordinary architectural planning belongs in general, and bounded planning within existing patterns belongs in quick.",
		candidates: [opus],
	},
};

const routeSchema = Type.Object(
	{
		description: Type.Optional(Type.String({ minLength: 1 })),
		candidates: Type.Optional(
			Type.Array(
				Type.Object(
					{
						provider: Type.Union([Type.Literal("openai-codex"), Type.Literal("anthropic")]),
						model: Type.String({ minLength: 1 }),
						thinking: Type.Union(
							["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)),
						),
					},
					{ additionalProperties: false },
				),
				{ minItems: 1 },
			),
		),
	},
	{ additionalProperties: false },
);

export default defineTauExtensionSettings({
	key: "decisions",
	defaults: {
		enabled: true as boolean,
		classifier: "auto" as "auto" | "jev" | "luna",
		approval: { enabled: true as boolean },
		answerFirst: { enabled: true as boolean },
		routing: {
			enabled: true as boolean,
			routes,
			balance: {
				windowHours: 24 as number,
				providerWeights: { "openai-codex": 2 as number, anthropic: 1 as number },
			},
		},
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true })),
			classifier: Type.Optional(
				Type.Union([Type.Literal("auto"), Type.Literal("jev"), Type.Literal("luna")], { default: "auto" }),
			),
			approval: Type.Optional(
				Type.Object({ enabled: Type.Optional(Type.Boolean({ default: true })) }, { additionalProperties: false }),
			),
			answerFirst: Type.Optional(
				Type.Object({ enabled: Type.Optional(Type.Boolean({ default: true })) }, { additionalProperties: false }),
			),
			routing: Type.Optional(
				Type.Object(
					{
						enabled: Type.Optional(Type.Boolean({ default: true })),
						routes: Type.Optional(
							Type.Object(
								Object.fromEntries(Object.keys(routes).map((key) => [key, Type.Optional(routeSchema)])),
								{ additionalProperties: false },
							),
						),
						balance: Type.Optional(
							Type.Object(
								{
									windowHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 24 })),
									providerWeights: Type.Optional(
										Type.Object(
											{
												"openai-codex": Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 2 })),
												anthropic: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 1 })),
											},
											{ additionalProperties: false },
										),
									),
								},
								{ additionalProperties: false },
							),
						),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
});
