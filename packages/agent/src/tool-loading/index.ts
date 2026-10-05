import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface ToolGroup {
	id: string;
	exposure: "deferred" | "codemode";
	description: string;
	tools: readonly ToolDefinition[];
}

/** Registers tools under one namespace so the model reaches them through Pi's `tool_search` or codemode. */
export function registerToolGroup(pi: Pick<ExtensionAPI, "registerTool">, group: ToolGroup): void {
	const id = group.id.trim();
	if (id.length === 0 || id !== group.id) throw new Error("Tool group ID must be non-empty and trimmed");
	if (group.description.trim().length === 0) throw new Error(`Tool group ${id} needs a description`);
	if (group.tools.length === 0) throw new Error(`Tool group ${id} needs at least one tool`);
	if (new Set(group.tools.map((tool) => tool.name)).size !== group.tools.length) {
		throw new Error(`Tool group ${id} contains duplicate tool names`);
	}
	for (const tool of group.tools) {
		pi.registerTool({ ...tool, exposure: group.exposure, namespace: { name: id, description: group.description } });
	}
}
