import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";

const TOOL_SEARCH = "tool_search";
const CODEMODE = "codemode";

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
		const active = pi.getActiveTools();
		const additions: string[] = [];

		if (tools.some((tool) => tool.exposure === "deferred")) {
			if (!tools.some((tool) => tool.name === TOOL_SEARCH)) {
				ctx.ui.notify(
					"Deferred tool groups need Pi's built-in tool_search extension, which is disabled.",
					"warning",
				);
			} else if (!active.includes(TOOL_SEARCH)) {
				additions.push(TOOL_SEARCH);
			}
		}

		if (tools.some((tool) => tool.exposure === "codemode")) {
			if (!tools.some((tool) => tool.name === CODEMODE)) {
				ctx.ui.notify("Codemode tool groups need Pi's built-in codemode extension, which is disabled.", "warning");
			} else if (!active.includes(CODEMODE)) {
				additions.push(CODEMODE);
			}
		}

		if (additions.length > 0) pi.setActiveTools([...active, ...additions]);
	});
}
