import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEffortCandidates } from "../../shared/model-effort.ts";
import { errorText } from "../../shared/text.ts";

export default function compactionExtension(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const session = ctx.model;
		if (!session) return undefined;
		const { preparation } = event;
		// Summaries stay on the session's provider, and the cheaper model needs room for the whole input.
		const candidates = (await resolveEffortCandidates(ctx, "quick", { includeParentModel: false })).filter(
			({ model }) =>
				model.provider === session.provider &&
				model.id !== session.id &&
				model.contextWindow >= preparation.tokensBefore + preparation.settings.reserveTokens,
		);
		for (const { model, reasoning } of candidates) {
			try {
				// Pi only carries file lists forward from its own compactions, not from extension-made ones.
				const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
				const details = previous?.type === "compaction" && previous.fromHook ? previous.details : undefined;
				if (details && typeof details === "object") {
					const { readFiles, modifiedFiles } = details as { readFiles?: unknown; modifiedFiles?: unknown };
					if (Array.isArray(readFiles)) for (const file of readFiles) preparation.fileOps.read.add(String(file));
					if (Array.isArray(modifiedFiles))
						for (const file of modifiedFiles) preparation.fileOps.edited.add(String(file));
				}
				const result = await compact(
					preparation,
					model,
					undefined,
					undefined,
					event.customInstructions,
					event.signal,
					reasoning,
					(streamModel, context, options) => ctx.modelRegistry.streamSimple(streamModel, context, options),
				);
				ctx.ui.notify(`Compaction summarized with ${model.provider}/${model.id}`, "info");
				return { compaction: result };
			} catch (error) {
				if (event.signal.aborted) return undefined;
				ctx.ui.notify(`Compaction with ${model.provider}/${model.id} failed: ${errorText(error)}`, "warning");
			}
		}
		return undefined;
	});
}
