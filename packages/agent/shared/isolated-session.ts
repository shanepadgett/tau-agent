import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type IsolatedSessionThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

type SelectedModel = NonNullable<ExtensionContext["model"]>;
type SelectedProvider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;

export interface IsolatedSessionInputs {
	label: string;
	extensionPaths: readonly string[];
	cwd: string;
	model: SelectedModel;
	provider: SelectedProvider;
	runtimeApiKey: string | undefined;
	thinkingLevel: IsolatedSessionThinkingLevel;
	tools: readonly string[];
	customTools: readonly ToolDefinition[];
	bindTarget: { mode: "print" } | { mode: "tui"; uiContext: ExtensionContext["ui"] };
}

export interface IsolatedSessionResource {
	readonly session: AgentSession;
	dispose(): Promise<void>;
}

type ModelAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

async function tryPreferredModel(
	ctx: ExtensionContext,
	preferredModel: string,
	onWarning?: (warning: string) => void,
): Promise<{ model: SelectedModel; auth: ModelAuth } | undefined> {
	const separator = preferredModel.indexOf("/");
	const configured = ctx.modelRegistry.find(preferredModel.slice(0, separator), preferredModel.slice(separator + 1));
	if (!configured) {
		onWarning?.(`model ${preferredModel} is unavailable; using parent model`);
		return undefined;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configured);
	if (!auth.ok) {
		onWarning?.(`model ${preferredModel} is unavailable: ${auth.error}; using parent model`);
		return undefined;
	}
	return { model: configured, auth };
}

function thinkingSupported(
	model: SelectedModel | undefined,
	preferred: IsolatedSessionThinkingLevel,
): preferred is IsolatedSessionThinkingLevel {
	const mapped = model?.thinkingLevelMap?.[preferred];
	if (!model?.reasoning || mapped === null) return false;
	if ((preferred === "xhigh" || preferred === "max") && mapped === undefined) return false;
	return true;
}

function resolveThinkingLevel(
	model: SelectedModel | undefined,
	parentThinkingLevel: IsolatedSessionThinkingLevel,
	preferredThinkingLevel: IsolatedSessionThinkingLevel | undefined,
	allowPreferred: boolean,
	onWarning?: (warning: string) => void,
): IsolatedSessionThinkingLevel {
	if (!preferredThinkingLevel || !allowPreferred) return parentThinkingLevel;
	if (thinkingSupported(model, preferredThinkingLevel)) return preferredThinkingLevel;
	onWarning?.(`thinking ${preferredThinkingLevel} is unavailable for the selected model; using parent thinking`);
	return parentThinkingLevel;
}

function runtimeApiKeyFor(
	ctx: ExtensionContext,
	model: SelectedModel,
	provider: SelectedProvider,
	auth: ModelAuth,
): string | undefined {
	if (!auth.ok) return undefined;
	if (!(auth.apiKey && provider.auth.apiKey && !ctx.modelRegistry.isUsingOAuth(model))) return undefined;
	return auth.apiKey;
}

export async function resolveIsolatedSessionModel(options: {
	label: string;
	preferredModel: string | undefined;
	preferredThinkingLevel: IsolatedSessionThinkingLevel | undefined;
	usePreferredThinkingAfterModelFallback: boolean;
	ctx: ExtensionContext;
	parentThinkingLevel: IsolatedSessionThinkingLevel;
	signal: AbortSignal;
	onWarning?: (warning: string) => void;
}): Promise<Pick<IsolatedSessionInputs, "model" | "provider" | "runtimeApiKey" | "thinkingLevel">> {
	const { ctx, signal, onWarning } = options;
	let model = ctx.model;
	let selectedAuth: ModelAuth | undefined;
	let preferredModelSelected = false;

	if (options.preferredModel) {
		const preferred = await tryPreferredModel(ctx, options.preferredModel, onWarning);
		if (preferred) {
			model = preferred.model;
			selectedAuth = preferred.auth;
			preferredModelSelected = true;
		}
	}

	const thinkingLevel = resolveThinkingLevel(
		model,
		options.parentThinkingLevel,
		options.preferredThinkingLevel,
		preferredModelSelected || options.usePreferredThinkingAfterModelFallback,
		onWarning,
	);
	if (!model) throw new Error(`${options.label} startup failed: parent has no model`);
	const auth = selectedAuth ?? (await ctx.modelRegistry.getApiKeyAndHeaders(model));
	if (!auth.ok) throw new Error(`${options.label} startup failed: ${auth.error}`);
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) throw new Error(`${options.label} startup failed: provider ${model.provider} is unavailable`);
	if (signal.aborted) throw new Error(`${options.label} startup aborted`);
	return {
		model,
		provider,
		runtimeApiKey: runtimeApiKeyFor(ctx, model, provider, auth),
		thinkingLevel,
	};
}

export async function createIsolatedSessionResource(
	inputs: IsolatedSessionInputs,
	signal: AbortSignal,
): Promise<IsolatedSessionResource> {
	let session: AgentSession | undefined;
	try {
		if (signal.aborted) throw new Error(`${inputs.label} startup aborted`);
		const modelRuntime = await ModelRuntime.create();
		modelRuntime.registerNativeProvider(inputs.provider);
		if (inputs.runtimeApiKey !== undefined)
			await modelRuntime.setRuntimeApiKey(inputs.model.provider, inputs.runtimeApiKey, { signal });
		if (signal.aborted) throw new Error(`${inputs.label} startup aborted`);
		const resourceLoader = new DefaultResourceLoader({
			cwd: inputs.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			additionalExtensionPaths: [...inputs.extensionPaths],
		});
		await resourceLoader.reload();
		if (signal.aborted) throw new Error(`${inputs.label} startup aborted`);
		const created = await createAgentSession({
			cwd: inputs.cwd,
			model: inputs.model,
			modelRuntime,
			thinkingLevel: inputs.thinkingLevel,
			tools: [...inputs.tools],
			excludeTools: ["subagent"],
			resourceLoader,
			customTools: [...inputs.customTools],
			sessionManager: SessionManager.inMemory(inputs.cwd),
		});
		session = created.session;
		if (signal.aborted) throw new Error(`${inputs.label} startup aborted`);
		await session.bindExtensions(inputs.bindTarget);
		if (signal.aborted) throw new Error(`${inputs.label} startup aborted`);
		const active = session.getActiveToolNames().sort();
		const expected = [...inputs.tools].sort();
		if (active.join("\0") !== expected.join("\0") || active.includes("subagent")) {
			const missing = expected.filter((tool) => !active.includes(tool));
			throw new Error(
				`${inputs.label} startup failed: unavailable tools: ${missing.join(", ") || "active tool mismatch"}`,
			);
		}
		let disposed = false;
		return {
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
