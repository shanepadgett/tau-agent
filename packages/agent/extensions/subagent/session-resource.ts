import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, ThinkingLevel } from "./agents.ts";

const CHILD_UI_BLOCKED_METHODS = new Set([
	"setEditorComponent",
	"setFooter",
	"setStatus",
	"setTitle",
	"setWidget",
	"setWorkingIndicator",
]);

type SelectedModel = NonNullable<ExtensionContext["model"]>;
type SelectedProvider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;

export interface SubagentSessionInputs {
	definition: AgentDefinition;
	extensionPaths: readonly string[];
	cwd: string;
	model: SelectedModel;
	modelName: string;
	provider: SelectedProvider;
	runtimeApiKey: string | undefined;
	thinkingLevel: ThinkingLevel;
	bindTarget: { mode: "print" } | { mode: "tui"; uiContext: ExtensionContext["ui"] };
}

export interface SubagentSessionResource {
	readonly inputs: SubagentSessionInputs;
	readonly session: AgentSession;
	dispose(): Promise<void>;
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
	parentThinkingLevel: string;
	signal: AbortSignal;
	onWarning?: (warning: string) => void;
}): Promise<SubagentSessionInputs> {
	const { definition, extensionPaths, ctx, signal, onWarning } = options;
	let model = ctx.model;
	let thinkingLevel = options.parentThinkingLevel as ThinkingLevel;
	let selectedAuth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>> | undefined;
	if (definition.model) {
		const separator = definition.model.indexOf("/");
		const configured = ctx.modelRegistry.find(
			definition.model.slice(0, separator),
			definition.model.slice(separator + 1),
		);
		if (!configured) onWarning?.(`model ${definition.model} is unavailable; using parent model`);
		else {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configured);
			if (!auth.ok) onWarning?.(`model ${definition.model} is unavailable: ${auth.error}; using parent model`);
			else {
				model = configured;
				selectedAuth = auth;
			}
		}
	}
	if (definition.thinking) {
		const mapped = model?.thinkingLevelMap?.[definition.thinking];
		const unsupported =
			!model?.reasoning ||
			mapped === null ||
			((definition.thinking === "xhigh" || definition.thinking === "max") && mapped === undefined);
		if (unsupported)
			onWarning?.(`thinking ${definition.thinking} is unavailable for the selected model; using parent thinking`);
		else thinkingLevel = definition.thinking;
	}
	if (!model) throw new Error(`Agent ${definition.name} startup failed: parent has no model`);
	const auth = selectedAuth ?? (await ctx.modelRegistry.getApiKeyAndHeaders(model));
	if (!auth.ok) throw new Error(`Agent ${definition.name} startup failed: ${auth.error}`);
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) throw new Error(`Agent ${definition.name} startup failed: provider ${model.provider} is unavailable`);
	if (signal.aborted) throw new Error(`Agent ${definition.name} startup aborted`);
	return {
		definition,
		extensionPaths: [...extensionPaths],
		cwd: ctx.cwd,
		model,
		modelName: `${model.provider}/${model.id}`,
		provider,
		runtimeApiKey:
			auth.apiKey && provider.auth.apiKey && !ctx.modelRegistry.isUsingOAuth(model) ? auth.apiKey : undefined,
		thinkingLevel,
		bindTarget:
			ctx.mode === "tui" && ctx.hasUI ? { mode: "tui", uiContext: childUiContext(ctx.ui) } : { mode: "print" },
	};
}

export async function createSubagentSessionResource(
	inputs: SubagentSessionInputs,
	signal: AbortSignal,
): Promise<SubagentSessionResource> {
	let session: AgentSession | undefined;
	try {
		if (signal.aborted) throw new Error(`Agent ${inputs.definition.name} startup aborted`);
		const modelRuntime = await ModelRuntime.create();
		modelRuntime.registerNativeProvider(inputs.provider);
		if (inputs.runtimeApiKey !== undefined)
			await modelRuntime.setRuntimeApiKey(inputs.model.provider, inputs.runtimeApiKey);
		if (signal.aborted) throw new Error(`Agent ${inputs.definition.name} startup aborted`);
		const resourceLoader = new DefaultResourceLoader({
			cwd: inputs.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			additionalExtensionPaths: [...inputs.extensionPaths],
		});
		await resourceLoader.reload();
		if (signal.aborted) throw new Error(`Agent ${inputs.definition.name} startup aborted`);
		const created = await createAgentSession({
			cwd: inputs.cwd,
			model: inputs.model,
			modelRuntime,
			thinkingLevel: inputs.thinkingLevel,
			tools: inputs.definition.tools,
			excludeTools: ["subagent"],
			resourceLoader,
			sessionManager: SessionManager.inMemory(inputs.cwd),
		});
		session = created.session;
		if (signal.aborted) throw new Error(`Agent ${inputs.definition.name} startup aborted`);
		await session.bindExtensions(inputs.bindTarget);
		if (signal.aborted) throw new Error(`Agent ${inputs.definition.name} startup aborted`);
		const active = session.getActiveToolNames().sort();
		const expected = [...inputs.definition.tools].sort();
		if (active.join("\0") !== expected.join("\0") || active.includes("subagent")) {
			const missing = expected.filter((tool) => !active.includes(tool));
			throw new Error(
				`Agent ${inputs.definition.name} startup failed: unavailable tools: ${missing.join(", ") || "active tool mismatch"}`,
			);
		}
		let disposed = false;
		return {
			inputs,
			session,
			async dispose() {
				if (disposed) return;
				disposed = true;
				if (session?.isStreaming) await session.abort().catch(() => undefined);
				session?.dispose();
			},
		};
	} catch (error) {
		if (session?.isStreaming) await session.abort().catch(() => undefined);
		session?.dispose();
		throw error;
	}
}
