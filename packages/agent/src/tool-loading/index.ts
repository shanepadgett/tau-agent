import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface DeferredToolGroup {
	id: string;
	description: string;
	tools: readonly ToolDefinition[];
}

/** Registers tools that stay out of the model's declarations until Pi's `tool_search` loads them. */
export function registerDeferredToolGroup(pi: Pick<ExtensionAPI, "registerTool">, group: DeferredToolGroup): void {
	const id = group.id.trim();
	if (id.length === 0 || id !== group.id) throw new Error("Deferred tool group ID must be non-empty and trimmed");
	if (group.description.trim().length === 0) throw new Error(`Deferred tool group ${id} needs a description`);
	if (group.tools.length === 0) throw new Error(`Deferred tool group ${id} needs at least one tool`);
	if (new Set(group.tools.map((tool) => tool.name)).size !== group.tools.length) {
		throw new Error(`Deferred tool group ${id} contains duplicate tool names`);
	}
	for (const tool of group.tools) {
		pi.registerTool({ ...tool, exposure: "deferred", namespace: { name: id, description: group.description } });
	}
}
