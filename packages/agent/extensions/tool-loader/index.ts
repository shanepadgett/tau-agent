import { defineTool, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { registeredDeferredToolGroups, type DeferredToolGroupInfo } from "../../src/tool-loading/index.ts";
import { emitTauEvent } from "../../shared/events.ts";
import { BoundedTextResultBuilder } from "../../shared/bounded-text-result.ts";
import { createTemporaryOutputStore } from "../../shared/temporary-output-store.ts";

const loadToolsSchema = Type.Object(
	{
		capability: Type.String({
			minLength: 1,
			description: "Registered specialist group ID, such as web, image, appshot, or a package-provided group",
		}),
	},
	{ additionalProperties: false },
);

type LoadToolsParams = Static<typeof loadToolsSchema>;

interface LoadToolsDetails {
	version: 1;
	capability: string;
	requestedToolNames: string[];
	addedToolNames: string[];
}

const PENDING_TYPE = "tau.tool-loader.pending";
const APPLIED_TYPE = "tau.tool-loader.applied";

interface AppliedLoad {
	pendingId: string;
	names: string[];
}

export default function toolLoaderExtension(pi: ExtensionAPI): void {
	let temporaryOutput = createTemporaryOutputStore();
	let managed = false;
	let allowedToolNames = new Map<string, ReadonlySet<string>>();
	let managedToolNames = new Set<string>();

	pi.registerTool(createLoadToolsTool(pi, []));

	pi.on("session_start", async (_event, ctx) => {
		temporaryOutput = createTemporaryOutputStore();
		await temporaryOutput.start();
		const groups = registeredDeferredToolGroups(pi);
		pi.registerTool(createLoadToolsTool(pi, groups));

		const initial = pi.getActiveTools();
		const initialSet = new Set(initial);
		allowedToolNames = new Map(
			groups.map((group) => [group.id, new Set(group.toolNames.filter((name) => initialSet.has(name)))]),
		);
		managedToolNames = new Set(groups.flatMap((group) => group.toolNames));
		managed = initialSet.has("load_tools") && groups.length > 0;
		if (managed) restoreActiveTools(pi, initial, loadedCapabilities(ctx.sessionManager.getBranch(), groups), groups);
	});
	pi.on("session_shutdown", () => temporaryOutput.shutdown());

	pi.on("session_tree", (_event, ctx) => {
		if (managed) {
			restoreActiveTools(
				pi,
				pi.getActiveTools(),
				loadedCapabilities(ctx.sessionManager.getBranch(), registeredDeferredToolGroups(pi)),
				registeredDeferredToolGroups(pi),
			);
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const applied = new Set(
			branch.flatMap((entry) =>
				entry.type === "custom" && entry.customType === APPLIED_TYPE ? [(entry.data as AppliedLoad).pendingId] : [],
			),
		);
		for (const entry of branch) {
			if (
				entry.type !== "custom" ||
				entry.customType !== PENDING_TYPE ||
				applied.has(entry.id) ||
				!Array.isArray(entry.data)
			)
				continue;
			const names = entry.data.filter((name): name is string => typeof name === "string");
			const allowed = new Set([...allowedToolNames.values()].flatMap((group) => [...group]));
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names.filter((name) => allowed.has(name))])]);
			pi.appendEntry(APPLIED_TYPE, { pendingId: entry.id, names });
		}
	});

	function createLoadToolsTool(pi: ExtensionAPI, groups: readonly DeferredToolGroupInfo[]) {
		return defineTool<typeof loadToolsSchema, LoadToolsDetails>({
			name: "load_tools",
			label: "Load Tools",
			description: `Load one registered Tau specialist tool group for the current session.${formatGroupCatalog(groups)}`,
			promptSnippet: "Load a registered specialist tool group when the current tools cannot perform the task",
			promptGuidelines: [
				"Use load_tools before attempting a registered specialist capability whose tools are not currently available.",
			],
			parameters: loadToolsSchema,
			async execute(_toolCallId, params: LoadToolsParams, signal, _onUpdate, ctx) {
				const group = registeredDeferredToolGroups(pi).find((candidate) => candidate.id === params.capability);
				if (group === undefined) {
					throw new Error(
						`Unknown specialist tool group: ${params.capability}.${formatGroupCatalog(registeredDeferredToolGroups(pi))}`,
					);
				}

				const before = pi.getActiveTools();
				const requested = [...group.toolNames];
				const registered = new Set(pi.getAllTools().map((tool) => tool.name));
				const allowed = allowedToolNames.get(group.id) ?? new Set<string>();
				const loadable = requested.filter((name) => registered.has(name) && allowed.has(name));
				if (loadable.length === 0) {
					throw new Error(`No ${params.capability} tools are available in this session's tool configuration.`);
				}

				const beforeSet = new Set(before);
				const next = [...before, ...loadable.filter((name) => !beforeSet.has(name))];
				const nextSet = new Set(next);
				let blocked: string | null = null;
				emitTauEvent(pi, "tau:prompt.tools.check", {
					ctx,
					tools: pi.getAllTools().filter((tool) => nextSet.has(tool.name)),
					reject(reason) {
						blocked = reason;
					},
				});
				if (blocked) {
					pi.appendEntry(PENDING_TYPE, loadable);
					return boundedResult(
						`${blocked} ${params.capability} is queued for activation after successful compaction.`,
						{ version: 1, capability: params.capability, requestedToolNames: requested, addedToolNames: [] },
						signal,
					);
				}
				pi.setActiveTools(next);
				const after = pi.getActiveTools();
				const addedToolNames = requested.filter((name) => !beforeSet.has(name) && after.includes(name));
				const available = requested.filter((name) => after.includes(name));
				const unavailable = requested.filter((name) => !after.includes(name));
				const text =
					addedToolNames.length > 0
						? `Loaded ${params.capability} tools: ${addedToolNames.join(", ")}.`
						: `${params.capability} tools are already loaded: ${available.join(", ")}.`;

				return boundedResult(
					unavailable.length ? `${text} Unavailable: ${unavailable.join(", ")}.` : text,
					{
						version: 1,
						capability: params.capability,
						requestedToolNames: requested,
						addedToolNames,
					},
					signal,
				);
			},
		});
	}

	async function boundedResult(text: string, details: LoadToolsDetails, signal: AbortSignal | undefined) {
		const builder = new BoundedTextResultBuilder(temporaryOutput, "head");
		try {
			await builder.append(text);
			signal?.throwIfAborted();
			const result = await builder.finish();
			return {
				content: [{ type: "text" as const, text: result.content }],
				details: { ...details, overflow: result.overflow },
			};
		} catch (error) {
			await builder.abort();
			throw error;
		}
	}

	function restoreActiveTools(
		pi: ExtensionAPI,
		current: readonly string[],
		loaded: ReadonlySet<string>,
		groups: readonly DeferredToolGroupInfo[],
	): void {
		const next = current.filter((name) => !managedToolNames.has(name));
		for (const group of groups) {
			if (!loaded.has(group.id)) continue;
			const allowed = allowedToolNames.get(group.id) ?? new Set<string>();
			next.push(...group.toolNames.filter((name) => allowed.has(name)));
		}
		pi.setActiveTools([...new Set(next)]);
	}
}

function formatGroupCatalog(groups: readonly DeferredToolGroupInfo[]): string {
	if (groups.length === 0) return " No specialist groups are registered.";
	const catalog = groups.map((group) => `${group.id}: ${group.description}`).join("; ");
	return ` Registered groups: ${catalog}.`;
}

function loadedCapabilities(entries: readonly SessionEntry[], groups: readonly DeferredToolGroupInfo[]): Set<string> {
	const loaded = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === APPLIED_TYPE) {
			const { names } = entry.data as AppliedLoad;
			for (const group of groups) if (group.toolNames.some((name) => names.includes(name))) loaded.add(group.id);
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "load_tools" || message.isError === true) continue;
		if (!isLoadToolsDetails(message.details)) continue;
		if (message.details.addedToolNames.length > 0) loaded.add(message.details.capability);
	}
	return loaded;
}

function isLoadToolsDetails(value: unknown): value is LoadToolsDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Record<string, unknown>;
	return (
		details.version === 1 &&
		typeof details.capability === "string" &&
		Array.isArray(details.requestedToolNames) &&
		details.requestedToolNames.every((name) => typeof name === "string") &&
		Array.isArray(details.addedToolNames) &&
		details.addedToolNames.every((name) => typeof name === "string")
	);
}
