import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";

const TOOL_SEARCH = "tool_search";

export default function toolLoaderExtension(pi: ExtensionAPI): void {
	// Pi's tool_search description lists no groups, so the agent only learns they exist from this section.
	// Sorted and deterministic: it changes only when a group is added or removed.
	registerPromptSource(pi, {
		key: "tool-loader/groups",
		section: "deferred-tools",
		refresh: "append",
		async read() {
			const tools = pi.getAllTools();
			if (!tools.some((tool) => tool.name === TOOL_SEARCH)) return "";
			const groups = new Map<string, string>();
			for (const tool of tools) {
				if (tool.exposure === "deferred" && tool.namespace) {
					groups.set(tool.namespace.name, tool.namespace.description ?? "");
				}
			}
			if (groups.size === 0) return "";
			const lines = [...groups.keys()].sort().map((name) => `- ${name}: ${groups.get(name)}`);
			return `## Deferred tools\nThese tool groups are not loaded. Load one with \`${TOOL_SEARCH}\` (search by group name or task) before using it:\n${lines.join("\n")}`;
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const tools = pi.getAllTools();
		if (!tools.some((tool) => tool.exposure === "deferred")) return;
		if (!tools.some((tool) => tool.name === TOOL_SEARCH)) {
			ctx.ui.notify("Deferred tool groups need Pi's built-in tool_search extension, which is disabled.", "warning");
			return;
		}
		const active = pi.getActiveTools();
		if (!active.includes(TOOL_SEARCH)) pi.setActiveTools([...active, TOOL_SEARCH]);
	});
}
