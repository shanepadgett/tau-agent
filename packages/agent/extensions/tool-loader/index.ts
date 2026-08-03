import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { registeredDeferredToolGroups, type DeferredToolGroupInfo } from "../../src/tool-loading/index.ts";

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

export default function toolLoaderExtension(pi: ExtensionAPI): void {
	let managed = false;
	let allowedToolNames = new Map<string, ReadonlySet<string>>();
	let managedToolNames = new Set<string>();

	pi.registerTool(createLoadToolsTool(pi, []));

	pi.on("session_start", (_event, ctx) => {
		const groups = registeredDeferredToolGroups(pi);
		pi.registerTool(createLoadToolsTool(pi, groups));

		const initial = pi.getActiveTools();
		const initialSet = new Set(initial);
		allowedToolNames = new Map(
			groups.map((group) => [group.id, new Set(group.toolNames.filter((name) => initialSet.has(name)))]),
		);
		managedToolNames = new Set(groups.flatMap((group) => group.toolNames));
		managed = initialSet.has("load_tools") && groups.length > 0;
		if (managed) restoreActiveTools(pi, initial, loadedCapabilities(ctx.sessionManager.getBranch()), groups);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (managed) {
			restoreActiveTools(
				pi,
				pi.getActiveTools(),
				loadedCapabilities(ctx.sessionManager.getBranch()),
				registeredDeferredToolGroups(pi),
			);
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
			async execute(_toolCallId, params: LoadToolsParams) {
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
				pi.setActiveTools([...before, ...loadable.filter((name) => !beforeSet.has(name))]);
				const after = pi.getActiveTools();
				const addedToolNames = requested.filter((name) => !beforeSet.has(name) && after.includes(name));
				const available = requested.filter((name) => after.includes(name));
				const unavailable = requested.filter((name) => !after.includes(name));
				const text =
					addedToolNames.length > 0
						? `Loaded ${params.capability} tools: ${addedToolNames.join(", ")}.`
						: `${params.capability} tools are already loaded: ${available.join(", ")}.`;

				return {
					content: [
						{
							type: "text" as const,
							text: unavailable.length ? `${text} Unavailable: ${unavailable.join(", ")}.` : text,
						},
					],
					details: {
						version: 1,
						capability: params.capability,
						requestedToolNames: requested,
						addedToolNames,
					},
				};
			},
		});
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

function loadedCapabilities(entries: readonly unknown[]): Set<string> {
	const loaded = new Set<string>();
	for (const value of entries) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "toolResult" || message.toolName !== "load_tools" || message.isError === true) continue;
		if (!isLoadToolsDetails(message.details)) continue;
		loaded.add(message.details.capability);
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
