import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { emitTauEvent, onTauEventImmediately } from "../../shared/events.ts";

export interface DeferredToolGroup {
	id: string;
	description: string;
	tools: readonly ToolDefinition[];
}

export type DeferredToolHost = Pick<ExtensionAPI, "events" | "on" | "registerTool">;

export interface DeferredToolGroupInfo {
	id: string;
	description: string;
	toolNames: readonly string[];
}

// Pi evaluates each extension in an isolated module graph, so module-local registries are not shared.
const DEFERRED_TOOL_GROUP_REQUEST_EVENT = "tau:deferred-tool-group.request";

export function registerDeferredToolGroup(pi: DeferredToolHost, group: DeferredToolGroup): void {
	const id = group.id.trim();
	if (id.length === 0 || id !== group.id) throw new Error("Deferred tool group ID must be non-empty and trimmed");
	if (group.description.trim().length === 0) throw new Error(`Deferred tool group ${id} needs a description`);
	if (group.tools.length === 0) throw new Error(`Deferred tool group ${id} needs at least one tool`);

	const toolNames = group.tools.map((tool) => tool.name);
	if (new Set(toolNames).size !== toolNames.length) {
		throw new Error(`Deferred tool group ${id} contains duplicate tool names`);
	}
	if (toolNames.includes("load_tools")) throw new Error("load_tools cannot be part of a deferred tool group");

	const groups = registeredDeferredToolGroups(pi);
	if (groups.some((existing) => existing.id === id)) {
		throw new Error(`Deferred tool group is already registered: ${id}`);
	}
	for (const existing of groups) {
		if (toolNames.some((name) => existing.toolNames.includes(name))) {
			throw new Error(`Deferred tool group ${id} overlaps an existing tool group`);
		}
	}

	for (const tool of group.tools) pi.registerTool(tool);
	const info = { id, description: group.description, toolNames } satisfies DeferredToolGroupInfo;
	onTauEventImmediately(pi, `deferred-tool-group.${id}`, DEFERRED_TOOL_GROUP_REQUEST_EVENT, ({ accept }) => {
		accept(info);
	});
}

export function registeredDeferredToolGroups(pi: Pick<ExtensionAPI, "events">): readonly DeferredToolGroupInfo[] {
	const groups: DeferredToolGroupInfo[] = [];
	emitTauEvent(pi, DEFERRED_TOOL_GROUP_REQUEST_EVENT, {
		accept(group: DeferredToolGroupInfo) {
			groups.push(group);
		},
	});
	return groups;
}
