import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onTauEvent } from "../../shared/events.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { registerWorkingMemoryTools, WORKING_MEMORY_GUIDANCE } from "./agent-surface.ts";
import { pruneWorkingMemoryContext } from "./context-pruning.ts";
import { createMutationMemory } from "./mutation-memory.ts";
import { createWorkingMemoryRenderState, registerWorkingMemoryRenderers } from "./renderers.ts";
import workingMemorySettings, { type WorkingMemorySettings } from "./settings.ts";

export default function workingMemory(pi: ExtensionAPI): void {
	const renderState = createWorkingMemoryRenderState();
	const mutationMemory = createMutationMemory({ getSettings: () => settings });
	let settings: WorkingMemorySettings = workingMemorySettings.defaults;

	registerWorkingMemoryTools(pi, renderState);
	registerWorkingMemoryRenderers(pi, renderState);

	const unsubscribeMutationEvent = onTauEvent(pi, "tau:file-mutation.applied", (event) => {
		return mutationMemory.sendMutationEvidence(pi, event);
	});
	const unsubscribeContextSnapshotEvent = onTauEvent(pi, "tau:context.snapshot", (event) => {
		return mutationMemory.sendContextRereads(pi, event);
	});

	pi.on("session_shutdown", () => {
		unsubscribeMutationEvent();
		unsubscribeContextSnapshotEvent();
	});

	pi.on("session_start", async (_event, ctx) => {
		settings = await loadWorkingMemorySettings(ctx);
		const leafId = ctx.sessionManager.getLeafId();
		const { messages } = buildSessionContext(ctx.sessionManager.getBranch(), leafId);
		const result = pruneWorkingMemoryContext(messages, ctx.cwd);
		renderState.setReadStatuses(result.readStatuses);
		renderState.setGrepStatuses(result.grepStatuses);
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nWorking memory:\n${WORKING_MEMORY_GUIDANCE.map((line) => `- ${line}`).join("\n")}`,
	}));

	pi.on("context", (event, ctx) => {
		const result = pruneWorkingMemoryContext(event.messages, ctx.cwd);
		renderState.setReadStatuses(result.readStatuses);
		renderState.setGrepStatuses(result.grepStatuses);
		return { messages: result.messages };
	});
}

async function loadWorkingMemorySettings(ctx: ExtensionContext): Promise<WorkingMemorySettings> {
	return loadTauExtensionSettings(ctx, workingMemorySettings);
}
