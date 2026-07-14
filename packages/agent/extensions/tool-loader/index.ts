import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const CAPABILITIES = ["web", "image", "appshot"] as const;
type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
	web: ["webfetch", "websearch", "codesearch"],
	image: ["image_gen"],
	appshot: ["list_windows", "screenshot_window", "activate_app"],
};
const SPECIALIST_TOOLS = CAPABILITIES.flatMap((capability) => CAPABILITY_TOOLS[capability]);

const loadToolsSchema = Type.Object(
	{
		capability: StringEnum(CAPABILITIES, {
			description: "Specialist group to load: web, image, or appshot",
		}),
	},
	{ additionalProperties: false },
);

type LoadToolsParams = Static<typeof loadToolsSchema>;

interface LoadToolsDetails {
	version: 1;
	capability: Capability;
	requestedToolNames: string[];
	addedToolNames: string[];
}

export default function toolLoaderExtension(pi: ExtensionAPI): void {
	let managed = false;
	let allowedSpecialistNames = new Set<string>();

	pi.registerTool(
		defineTool<typeof loadToolsSchema, LoadToolsDetails>({
			name: "load_tools",
			label: "Load Tools",
			description:
				"Load one Tau specialist tool group for the current session. Groups: web for public web and implementation research; image for raster generation and editing; appshot for macOS window discovery, capture, and activation.",
			promptSnippet: "Load a specialist Tau tool group for web research, image generation, or macOS app inspection",
			promptGuidelines: [
				"Use load_tools before attempting a specialist capability whose tools are not currently available.",
			],
			parameters: loadToolsSchema,
			async execute(_toolCallId, params: LoadToolsParams) {
				const before = pi.getActiveTools();
				const requested = [...CAPABILITY_TOOLS[params.capability]];
				const registered = new Set(pi.getAllTools().map((tool) => tool.name));
				const loadable = requested.filter((name) => registered.has(name) && allowedSpecialistNames.has(name));
				if (loadable.length === 0) {
					throw new Error(`No ${params.capability} tools are available in this session's tool configuration.`);
				}
				const beforeSet = new Set(before);
				const next = [...before, ...loadable.filter((name) => !beforeSet.has(name))];
				pi.setActiveTools(next);
				const after = pi.getActiveTools();
				const addedToolNames = after.filter((name) => !beforeSet.has(name));
				const available = requested.filter((name) => after.includes(name));
				const unavailable = requested.filter((name) => !after.includes(name));
				const label = `${params.capability[0]?.toUpperCase()}${params.capability.slice(1)}`;
				const text =
					addedToolNames.length > 0
						? `Loaded ${params.capability} tools: ${addedToolNames.join(", ")}.`
						: `${label} tools are already loaded: ${available.join(", ")}.`;
				return {
					content: [
						{
							type: "text",
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
		}),
	);

	pi.on("session_start", (_event, ctx) => {
		const initial = pi.getActiveTools();
		const initialSet = new Set(initial);
		allowedSpecialistNames = new Set(SPECIALIST_TOOLS.filter((name) => initialSet.has(name)));
		managed = initialSet.has("load_tools") && SPECIALIST_TOOLS.every((name) => initialSet.has(name));
		if (managed) restoreActiveTools(pi, initial, loadedCapabilities(ctx.sessionManager.getBranch()));
	});

	pi.on("session_tree", (_event, ctx) => {
		if (managed) restoreActiveTools(pi, pi.getActiveTools(), loadedCapabilities(ctx.sessionManager.getBranch()));
	});
}

function restoreActiveTools(pi: ExtensionAPI, current: readonly string[], loaded: ReadonlySet<Capability>): void {
	const specialist = new Set(SPECIALIST_TOOLS);
	const next = current.filter((name) => !specialist.has(name));
	for (const capability of CAPABILITIES) {
		if (loaded.has(capability)) next.push(...CAPABILITY_TOOLS[capability]);
	}
	pi.setActiveTools([...new Set(next)]);
}

function loadedCapabilities(entries: readonly unknown[]): Set<Capability> {
	const loaded = new Set<Capability>();
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
		CAPABILITIES.includes(details.capability as Capability) &&
		Array.isArray(details.requestedToolNames) &&
		details.requestedToolNames.every((name) => typeof name === "string") &&
		Array.isArray(details.addedToolNames) &&
		details.addedToolNames.every((name) => typeof name === "string")
	);
}
