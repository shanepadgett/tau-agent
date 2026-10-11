import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

export interface Route {
	description: string;
	provider: "openai-codex" | "anthropic";
	model: string;
	thinking: ThinkingLevel;
}

const routes: Record<"quick" | "general" | "frontend" | "design" | "newDesign" | "writing" | "architecture", Route> = {
	quick: {
		description: "Small, clear changes to an existing system, even if a few clarifying questions are needed",
		provider: "openai-codex",
		model: "gpt-6-luna",
		thinking: "max",
	},
	general: {
		description: "General coding and debugging",
		provider: "openai-codex",
		model: "gpt-6.1-sol",
		thinking: "high",
	},
	frontend: {
		description: "Implementation involving front-end work",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		thinking: "high",
	},
	design: {
		description: "UI and design-system tweaks and small reinventions within an existing design system",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		thinking: "high",
	},
	newDesign: {
		description: "Hard UI and design-system work: entirely new paradigms",
		provider: "anthropic",
		model: "claude-opus-5-5",
		thinking: "high",
	},
	writing: {
		description: "Prose, docs, wording",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		thinking: "medium",
	},
	architecture: {
		description: "Software architecture and code planning",
		provider: "anthropic",
		model: "claude-opus-5-5",
		thinking: "high",
	},
};

const routeSchema = Type.Object(
	{
		description: Type.Optional(Type.String({ minLength: 1 })),
		provider: Type.Optional(Type.Union([Type.Literal("openai-codex"), Type.Literal("anthropic")])),
		model: Type.Optional(Type.String({ minLength: 1 })),
		thinking: Type.Optional(
			Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level))),
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
		routing: { enabled: true as boolean, routes },
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
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
});
