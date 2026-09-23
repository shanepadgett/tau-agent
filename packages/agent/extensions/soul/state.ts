import type { Tool } from "@earendil-works/pi-ai";
import type { ContextWithSystemEvent, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PromptValue } from "../../shared/prompt-contributions.ts";

export const BASELINE_TYPE = "tau.soul.baseline";
export const UPDATE_TYPE = "tau.soul.update";

export interface SavedBaseline {
	version: 1;
	compactionId: string | null;
	afterEntryId: string;
	text: string;
	values: PromptValue[];
	initialTools: Tool[];
}

export interface SavedUpdate {
	version: 1;
	baselineEntryId: string;
	afterEntryId: string;
	text: string;
	values: PromptValue[];
	tools: Tool[];
}

interface ActivePrompt {
	entryId: string;
	baseline: SavedBaseline;
	updates: Array<{ timestamp: number; data: SavedUpdate }>;
}

export function restorePrompt(branch: readonly SessionEntry[]): ActivePrompt | null {
	const newestFirst = [...branch].reverse();
	const compaction = newestFirst.find((entry) => entry.type === "compaction");
	const entry = newestFirst.find((item) => item.type === "custom" && item.customType === BASELINE_TYPE);
	if (entry?.type !== "custom") return null;
	const baseline = entry.data as SavedBaseline;
	if (baseline?.version !== 1 || typeof baseline.text !== "string" || !Array.isArray(baseline.values)) {
		throw new Error("Invalid saved Soul baseline.");
	}
	if (baseline.compactionId !== (compaction?.id ?? null)) return null;
	const updates: ActivePrompt["updates"] = [];
	for (const item of branch) {
		if (item.type !== "custom" || item.customType !== UPDATE_TYPE) continue;
		const data = item.data as SavedUpdate;
		if (data?.version !== 1 || typeof data.text !== "string" || !Array.isArray(data.values)) {
			throw new Error("Invalid saved Soul update.");
		}
		if (data.baselineEntryId === entry.id) updates.push({ timestamp: Date.parse(item.timestamp), data });
	}
	return { entryId: entry.id, baseline, updates };
}

/** Rebuild only Soul's text; tool declarations retain their original transcript positions. */
export function projectPrompt(
	messages: ContextWithSystemEvent["messages"],
	saved: ActivePrompt,
	ctx: ExtensionContext,
): ContextWithSystemEvent["messages"] {
	const projection = ctx.sessionManager.buildSessionProjection();
	// Pi clones the hook input. Compare content, never object identity. A rewrite from
	// another extension must not silently move a saved update or tool declaration.
	if (JSON.stringify(messages) !== JSON.stringify(projection.messages)) {
		throw new Error("Soul cannot preserve the prompt prefix: another extension changed request history.");
	}
	const output: ContextWithSystemEvent["messages"] = [
		{
			role: "system",
			content: saved.baseline.text,
			toolsAdded: saved.baseline.initialTools,
			timestamp: 0,
		},
	];
	let pastBaseline = false;
	const placed = new Set<SavedUpdate>();
	const admitted = new Set(saved.baseline.initialTools.map((tool) => tool.name));
	for (const entry of projection.entries) {
		for (const message of entry.messages) {
			if (message.role !== "system") {
				output.push(message);
				continue;
			}
			if (!pastBaseline) continue;
			if (typeof message.content === "string" ? message.content.trim() : message.content.length > 0) {
				throw new Error("A later system instruction bypassed Soul's prompt contributions.");
			}
			// Removed tools remain declared for cache stability; Pi still controls execution.
			const added = (message.toolsAdded ?? []).filter((tool) => !admitted.has(tool.name));
			for (const tool of added) admitted.add(tool.name);
			if (added.length > 0)
				output.push({ role: "system", content: "", toolsAdded: added, timestamp: message.timestamp });
		}
		if (entry.sourceEntry.id === saved.baseline.afterEntryId) pastBaseline = true;
		for (const update of saved.updates) {
			if (update.data.afterEntryId !== entry.sourceEntry.id) continue;
			if (update.data.text)
				output.push({
					role: "custom",
					customType: UPDATE_TYPE,
					content: update.data.text,
					display: false,
					timestamp: update.timestamp,
				});
			placed.add(update.data);
		}
	}
	if (!pastBaseline || placed.size !== saved.updates.length)
		throw new Error("Soul prompt history lost a saved anchor.");
	return output;
}

export function admittedTools(saved: ActivePrompt): Tool[] {
	return saved.updates.at(-1)?.data.tools ?? saved.baseline.initialTools;
}
