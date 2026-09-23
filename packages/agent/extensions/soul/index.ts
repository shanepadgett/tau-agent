import { getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitTauEvent, onTauEventImmediately } from "../../shared/events.ts";
import { readPromptValues, renderBaseline, renderUpdate } from "./context.ts";
import {
	admittedTools,
	BASELINE_TYPE,
	projectPrompt,
	restorePrompt,
	UPDATE_TYPE,
	type SavedBaseline,
	type SavedUpdate,
} from "./state.ts";
import { toolChangeReason } from "./tools.ts";

const CHECKPOINT_TYPE = "tau.soul.prefix";
interface PrefixCheckpoint {
	baselineEntryId: string;
	count: number;
	hash: string;
}

export default function soulExtension(pi: ExtensionAPI): void {
	let inputs: BuildSystemPromptOptions | null = null;

	pi.on("session_start", () => {
		inputs = null;
	});
	pi.on("session_shutdown", () => {
		inputs = null;
	});
	pi.on("before_agent_start", (event) => {
		// Keep the shared options reference until all contributors have finished.
		inputs = event.systemPromptOptions;
	});

	onTauEventImmediately(pi, "soul.tools", "tau:prompt.tools.check", ({ ctx, tools, reject }) => {
		try {
			const saved = restorePrompt(ctx.sessionManager.getBranch());
			if (!saved || !ctx.model) return;
			const previous = admittedTools(saved);
			// getAllTools exposes schemas but not constrainedSampling. Preserve that
			// metadata here; the request boundary checks the complete Pi declarations.
			const reason = toolChangeReason(
				ctx.model,
				previous,
				tools.map((tool) => ({
					...previous.find((candidate) => candidate.name === tool.name),
					...tool,
				})),
			);
			if (reason) reject(reason);
		} catch (error) {
			reject(String(error));
		}
	});

	pi.on("context_with_system", async (event, ctx) => {
		try {
			if (!inputs) throw new Error("Soul has no loaded prompt inputs.");
			if (inputs.forceSystemPrompt !== undefined)
				throw new Error(
					"A forced system prompt conflicts with Soul. Remove the extension's systemPrompt replacement.",
				);
			const branch = ctx.sessionManager.getBranch();
			const newestFirst = [...branch].reverse();
			const projection = ctx.sessionManager.buildSessionProjection();
			const anchor = [...projection.entries].reverse().find((entry) => entry.messages.length > 0);
			if (!anchor) throw new Error("Soul has no conversation anchor.");
			const saved = restorePrompt(branch);
			const active = new Set(pi.getActiveTools());
			const requested = getCurrentTools(event.messages)
				.filter((tool) => active.has(tool.name))
				.map(toToolDeclaration);
			if (saved && ctx.model) {
				const reason = toolChangeReason(ctx.model, admittedTools(saved), requested);
				if (reason) throw new Error(reason);
			}
			const values = await readPromptValues(pi, ctx, inputs, saved === null);
			if (!saved) {
				pi.appendEntry<SavedBaseline>(BASELINE_TYPE, {
					version: 1,
					compactionId: newestFirst.find((entry) => entry.type === "compaction")?.id ?? null,
					afterEntryId: anchor.sourceEntry.id,
					text: renderBaseline(inputs, values),
					values,
					initialTools: getCurrentTools(event.messages),
				});
			} else {
				const previous = new Map(saved.baseline.values.map((value) => [value.key, value]));
				for (const update of saved.updates) for (const value of update.data.values) previous.set(value.key, value);
				const currentKeys = new Set(values.map((value) => value.key));
				for (const value of previous.values()) {
					if (value.refresh === "append" && !currentKeys.has(value.key)) values.push({ ...value, text: "" });
				}
				const changed = values.filter((value) => previous.get(value.key)?.text !== value.text);
				const tools = new Map(admittedTools(saved).map((tool) => [tool.name, tool]));
				const added = requested.some((tool) => !tools.has(tool.name));
				for (const tool of requested) tools.set(tool.name, tool);
				if (changed.length > 0 || added)
					pi.appendEntry<SavedUpdate>(UPDATE_TYPE, {
						version: 1,
						baselineEntryId: saved.entryId,
						afterEntryId: anchor.sourceEntry.id,
						text: renderUpdate(changed),
						values: changed,
						tools: [...tools.values()],
					});
			}
			const admitted = restorePrompt(ctx.sessionManager.getBranch());
			if (!admitted) throw new Error("Soul failed to save its baseline.");
			const messages = projectPrompt(event.messages, admitted, ctx);
			const checkpointEntry = newestFirst.find(
				(entry) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE,
			);
			const checkpoint = checkpointEntry?.type === "custom" ? (checkpointEntry.data as PrefixCheckpoint) : null;
			if (checkpoint?.baselineEntryId === admitted.entryId) {
				const prefix = createHash("sha256")
					.update(JSON.stringify(messages.slice(0, checkpoint.count)))
					.digest("hex");
				if (prefix !== checkpoint.hash)
					throw new Error("Previously sent conversation content changed. Compact before continuing.");
			}
			const hash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
			if (hash !== checkpoint?.hash)
				pi.appendEntry<PrefixCheckpoint>(CHECKPOINT_TYPE, {
					baselineEntryId: admitted.entryId,
					count: messages.length,
					hash,
				});
			emitTauEvent(pi, "tau:prompt.snapshot", {
				text: [admitted.baseline.text, ...admitted.updates.map((update) => update.data.text)].join("\n\n"),
			});
			return { messages };
		} catch (error) {
			ctx.ui.notify(`Soul stopped this request: ${error instanceof Error ? error.message : String(error)}`, "error");
			ctx.abort();
			// Pi currently enters the provider with an aborted signal; do not weaken that
			// cancellation into a fallback prompt. See soul-request-check-findings.md.
			return undefined;
		}
	});
}
