import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { emitTauEvent } from "../../shared/events.ts";
import autoCompactSettings, { DEFAULT_AUTO_COMPACT_TOKEN_LIMIT } from "./settings.ts";

const CONTINUATION_TYPE = "tau.auto-compact";
const CONTINUATION_MESSAGE =
	"Continue the current work directly from the compacted context. Do not mention compaction or wait for user input.";

export default function autoCompactExtension(pi: ExtensionAPI): void {
	let tokenLimit = DEFAULT_AUTO_COMPACT_TOKEN_LIMIT;
	let armed = true;
	let compacting = false;
	let sessionVersion = 0;
	let attentionHoldSequence = 0;
	let attentionHoldId: string | undefined;
	let silentCheckPauseId: string | undefined;
	let continuationPending = false;

	function releaseAttentionHold(disposition: "notify" | "discard"): void {
		const holdId = attentionHoldId;
		attentionHoldId = undefined;
		if (holdId) emitTauEvent(pi, "tau:attention.hold.release", { id: holdId, disposition });
	}

	function pauseSilentChecks(): void {
		if (silentCheckPauseId) return;
		silentCheckPauseId = `auto-compact:${++attentionHoldSequence}`;
		emitTauEvent(pi, "tau:silent-command-runner.pause", { id: silentCheckPauseId });
	}

	function resumeSilentChecks(disposition: "continue" | "settle"): void {
		const pauseId = silentCheckPauseId;
		silentCheckPauseId = undefined;
		if (pauseId) emitTauEvent(pi, "tau:silent-command-runner.resume", { id: pauseId, disposition });
	}

	pi.on("session_start", async (_event, ctx) => {
		const version = ++sessionVersion;
		const settings = await loadTauExtensionSettings(ctx, autoCompactSettings);
		if (version !== sessionVersion) return;
		tokenLimit = settings.tokenLimit;
		armed = true;
		compacting = false;
		attentionHoldSequence = 0;
		attentionHoldId = undefined;
		silentCheckPauseId = undefined;
		continuationPending = false;
	});
	pi.on("session_shutdown", () => {
		sessionVersion++;
		armed = true;
		compacting = false;
		attentionHoldId = undefined;
		silentCheckPauseId = undefined;
		continuationPending = false;
	});
	pi.on("session_tree", () => {
		armed = true;
	});
	pi.on("session_compact", () => {
		armed = false;
	});
	pi.on("agent_settled", () => {
		if (!continuationPending) return;
		continuationPending = false;
		releaseAttentionHold("notify");
	});
	pi.on("turn_start", (_event, ctx) => {
		if (compacting) return;

		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens === undefined || tokens === null) return;
		if (tokens < tokenLimit) {
			armed = true;
			return;
		}
		if (!armed) return;

		armed = false;
		compacting = true;
		// Pause before compact: compact aborts the agent, and that agent_end must not run checks.
		pauseSilentChecks();
		if (ctx.mode !== "print") {
			attentionHoldId = `auto-compact:${++attentionHoldSequence}`;
			emitTauEvent(pi, "tau:attention.hold.acquire", { id: attentionHoldId });
		}
		const version = sessionVersion;
		const continueWork = (): void => {
			if (version !== sessionVersion) return;
			compacting = false;
			// Keep the silent-check baseline across the new agent run started below.
			resumeSilentChecks("continue");
			continuationPending = true;
			pi.sendMessage(
				{
					customType: CONTINUATION_TYPE,
					content: CONTINUATION_MESSAGE,
					display: false,
					details: { v: 1, kind: "auto-compact.continuation", source: "auto-compact" },
				},
				{ triggerTurn: true },
			);
		};

		ctx.compact({
			onComplete: continueWork,
			onError: (error) => {
				if (version !== sessionVersion) return;
				compacting = false;
				if (error.name === "AbortError" || error.message === "Compaction cancelled") {
					resumeSilentChecks("settle");
					releaseAttentionHold("notify");
					return;
				}
				continueWork();
			},
		});
	});
}
