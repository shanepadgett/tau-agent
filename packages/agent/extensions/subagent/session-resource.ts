import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveIsolatedSessionModel, type IsolatedSessionInputs } from "../../shared/isolated-session.ts";
import type { AgentDefinition, ThinkingLevel } from "./agents.ts";

const CHILD_UI_BLOCKED_METHODS = new Set([
	"setEditorComponent",
	"setFooter",
	"setStatus",
	"setTitle",
	"setWidget",
	"setWorkingIndicator",
]);

export interface SubagentSessionInputs extends IsolatedSessionInputs {
	definition: AgentDefinition;
	modelName: string;
	thinkingLevel: ThinkingLevel;
}

function childUiContext(ui: ExtensionContext["ui"]): ExtensionContext["ui"] {
	return new Proxy(ui, {
		get(target, property, receiver) {
			if (typeof property === "string" && CHILD_UI_BLOCKED_METHODS.has(property)) return () => undefined;
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export async function resolveSubagentSessionInputs(options: {
	definition: AgentDefinition;
	extensionPaths: readonly string[];
	ctx: ExtensionContext;
	parentThinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]>;
	signal: AbortSignal;
	onWarning?: (warning: string) => void;
}): Promise<SubagentSessionInputs> {
	const { definition, extensionPaths, ctx, signal, onWarning } = options;
	const selected = await resolveIsolatedSessionModel({
		label: `Agent ${definition.name}`,
		preferredModel: definition.model,
		preferredThinkingLevel: definition.thinking,
		usePreferredThinkingAfterModelFallback: true,
		ctx,
		parentThinkingLevel: options.parentThinkingLevel,
		signal,
		...(onWarning === undefined ? {} : { onWarning }),
	});
	return {
		...selected,
		label: `Agent ${definition.name}`,
		definition,
		extensionPaths: [...extensionPaths],
		cwd: ctx.cwd,
		modelName: `${selected.model.provider}/${selected.model.id}`,
		tools: definition.tools,
		customTools: [],
		bindTarget:
			ctx.mode === "tui" && ctx.hasUI ? { mode: "tui", uiContext: childUiContext(ctx.ui) } : { mode: "print" },
	};
}
