import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emitTauEvent, type TauAgentEvents } from "../../shared/events.ts";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import settingsSpec from "./settings.ts";
import { summarize } from "./summary.ts";

const STATE = "tau.compaction.state";
const NOTE = "tau.compaction.note";
const CONTINUE = "tau.compaction.continue";
const RESUME = "Continue from the checkpoint's Current handoff and NEXT ACTION.";
const PROGRESS = "tau.compaction.progress";
const GUIDANCE = "tau.compaction.guidance";
const PROMPTS = {
	notice: readFileSync(new URL("./prompts/notice.md", import.meta.url), "utf8"),
	warning: readFileSync(new URL("./prompts/warning.md", import.meta.url), "utf8"),
	forced: readFileSync(new URL("./prompts/forced.md", import.meta.url), "utf8"),
};

type State =
	| { phase: "watching"; cycle: number; nudged: boolean; forced: boolean }
	| {
			phase: "pending" | "compacting" | "failed" | "ready";
			cycle: number;
			id: string;
			toolCallId: string;
			note: string;
	  };
type Level = TauAgentEvents["tau:compaction.level"];

// Use the canonical projection so omitted or edited history cannot reappear in a summary.
function hasMaterial(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.buildSessionProjection().messages.some((message) => {
		if (message.role === "user") return true;
		if (message.role === "toolResult") return message.toolName !== "self_compact";
		if (message.role === "assistant")
			return message.content.some(
				(part) =>
					(part.type === "text" && !!part.text.trim()) ||
					(part.type === "toolCall" && part.name !== "self_compact"),
			);
		return false;
	});
}

export function registerSelfCompaction(pi: ExtensionAPI): void {
	let settings = settingsSpec.defaults;
	let state: State = { phase: "watching", cycle: 0, nudged: false, forced: false };
	let lifetime = new AbortController();
	let lastLevel: string = "";
	let progress: { ctx: ExtensionContext; loader: Loader | null } | null = null;
	function clearProgress() {
		if (!progress) return;
		progress.loader?.stop();
		progress.ctx.ui.setWidget(PROGRESS, undefined);
		progress = null;
	}
	function showProgress(ctx: ExtensionContext) {
		clearProgress();
		if (!ctx.hasUI) return;
		const current = { ctx, loader: null as Loader | null };
		progress = current;
		ctx.ui.setWidget(
			PROGRESS,
			(tui, theme) => {
				const loader = new Loader(
					tui,
					(text) => theme.fg("accent", text),
					(text) => theme.fg("muted", text),
					"Compacting context…",
				);
				current.loader = loader;
				return {
					render: (width) => loader.render(width),
					invalidate: () => loader.invalidate(),
					dispose: () => loader.stop(),
				};
			},
			{ placement: "aboveEditor" },
		);
	}
	const save = () => pi.appendEntry(STATE, structuredClone(state));
	function restore(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		const latest = [...branch].reverse().find((entry) => entry.type === "custom" && entry.customType === STATE);
		state =
			latest?.type === "custom" && latest.data
				? (structuredClone(latest.data) as State)
				: { phase: "watching", cycle: 0, nudged: false, forced: false };
		if (state.phase !== "watching") {
			const id = state.id;
			const delivered = branch.some(
				(entry) =>
					(entry.type === "compaction" &&
						(entry.details as { handoffId?: string } | undefined)?.handoffId === id) ||
					(entry.type === "custom_message" &&
						entry.customType === NOTE &&
						(entry.details as { id?: string } | undefined)?.id === id),
			);
			if (delivered) state = { phase: "watching", cycle: state.cycle + 1, nudged: false, forced: false };
			else if (
				state.phase === "ready" ||
				(latest && branch.slice(branch.indexOf(latest) + 1).some((entry) => entry.type === "compaction"))
			)
				state.phase = "ready";
			else state.phase = "pending";
		}
		lastLevel = "";
	}
	async function refresh(ctx: ExtensionContext) {
		settings = await loadTauExtensionSettings(ctx, settingsSpec);
		const { noticeTokens, warningTokens, forcedTokens } = settings.selfCompact;
		if (noticeTokens >= warningTokens || warningTokens >= forcedTokens) {
			settings = { selfCompact: { ...settingsSpec.defaults.selfCompact, enabled: settings.selfCompact.enabled } };
			ctx.ui.notify(
				"Self-compaction thresholds must increase: notice < warning < forced. Using defaults.",
				"warning",
			);
		}
	}
	function level(ctx: ExtensionContext): Level {
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		const window = ctx.model?.contextWindow ?? 0;
		const reserve = SettingsManager.create(ctx.cwd).getCompactionReserveTokens(ctx.model);
		const cap = Math.floor(Math.min(window * 0.9, window - reserve - 1));
		if (!settings.selfCompact.enabled || cap < 3) return { level: "normal", tokens, thresholds: null };
		const forced = Math.min(settings.selfCompact.forcedTokens, cap);
		const warning = Math.min(settings.selfCompact.warningTokens, forced - 1);
		const notice = Math.min(settings.selfCompact.noticeTokens, warning - 1);
		const thresholds = { notice, warning, forced };
		let current: Level["level"] =
			state.phase !== "watching"
				? "compacting"
				: state.forced
					? "forced"
					: tokens !== null && tokens >= forced
						? "forced"
						: tokens !== null && tokens >= warning
							? "warning"
							: tokens !== null && tokens >= notice
								? "notice"
								: "normal";
		if (current === "forced" && state.phase === "watching" && !state.forced && hasMaterial(ctx)) {
			state.forced = true;
			save();
		}
		if (current === "forced" && state.phase === "watching" && !state.forced) current = "normal";
		return { level: current, tokens, thresholds };
	}
	function publish(ctx: ExtensionContext) {
		const current = level(ctx);
		const fingerprint = JSON.stringify(current);
		if (fingerprint !== lastLevel) {
			lastLevel = fingerprint;
			emitTauEvent(pi, "tau:compaction.level", current);
		}
		return current;
	}
	function guidance(current: Level): string {
		if (!current.thresholds || current.level === "normal" || current.level === "compacting") return "";
		const values: Record<string, number | null> = { tokens: current.tokens, ...current.thresholds };
		return PROMPTS[current.level].replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
			String(values[key] ?? "unknown"),
		);
	}
	async function route(note: string, ctx: ExtensionContext) {
		const timeout = AbortSignal.timeout(3000);
		const signal = AbortSignal.any([timeout, lifetime.signal, ...(ctx.signal ? [ctx.signal] : [])]);
		const waits: Promise<void>[] = [];
		emitTauEvent(pi, "tau:compaction.handoff", { note, ctx, signal, waitFor: (promise) => waits.push(promise) });
		// Classification has a hard deadline. Finish an already-started local model commit
		// before continuing; abandoning setModel's promise could switch models mid-request.
		await Promise.allSettled(waits);
	}
	registerPromptSource(pi, {
		key: "compaction/self-compact",
		section: "context-management",
		refresh: "append",
		async read() {
			return settings.selfCompact.enabled
				? "Manage context through self_compact. When context guidance appears at the end of the conversation, compact at a natural stopping point. Call alone with a short current handoff: the user's request and authorization limits, unfinished work, immediate blockers, unanswered questions, and exact NEXT ACTION last. Aim for 500–1,500 characters; maximum 24,000. The handoff is preserved verbatim once inside the checkpoint; durable context is summarized separately."
				: "";
		},
	});
	pi.registerTool({
		name: "self_compact",
		label: "Compact context",
		exposure: "model-only",
		description:
			"Compact context with a short current handoff: request and authorization limits, unfinished work, blockers, unanswered questions, NEXT ACTION last. Call alone. Preserved verbatim once inside the checkpoint, then continue. Aim for 500–1,500 characters; maximum 24,000.",
		parameters: Type.Object(
			{ note_to_self: Type.String({ minLength: 1, maxLength: 24000 }) },
			{ additionalProperties: false },
		),
		async execute(toolCallId, params, signal, _update, ctx) {
			if (signal?.aborted || lifetime.signal.aborted) throw new Error("Self-compaction cancelled");
			if (!settings.selfCompact.enabled) throw new Error("Self-compaction is disabled");
			if (state.phase !== "watching") throw new Error("A compaction note is already pending");
			if (!params.note_to_self.trim()) throw new Error("The note must not be blank");
			if (!hasMaterial(ctx)) throw new Error("Nothing new to compact beyond the current checkpoint");
			state = { phase: "pending", cycle: state.cycle, id: randomUUID(), toolCallId, note: params.note_to_self };
			save();
			publish(ctx);
			// Inherently bounded fixed text; no overflow store is needed.
			return {
				content: [
					{
						type: "text",
						text: "Handoff saved; stop now. Compaction will preserve it inside the checkpoint before you continue.",
					},
				],
				details: undefined,
				terminate: true,
			};
		},
	});
	pi.on("tool_call", (event, ctx) => {
		if (state.phase !== "watching")
			return { block: true, terminate: true, reason: "Compaction is pending. Wait for your saved note." };
		if (!settings.selfCompact.enabled) return;
		const current = publish(ctx);
		if (event.toolName === "self_compact") return;
		const assistant = [...ctx.sessionManager.buildSessionProjection().messages]
			.reverse()
			.find((message) => message.role === "assistant");
		const sibling =
			assistant?.role === "assistant" &&
			assistant.content.some((part) => part.type === "toolCall" && part.name === "self_compact");
		if (sibling)
			return { block: true, terminate: true, reason: "self_compact must run alone. Wait for the saved note." };
		if (current.level === "forced")
			return {
				block: true,
				reason: "Context hard cutoff reached. Only self_compact is allowed until compaction succeeds.",
			};
	});
	pi.on("context", (event, ctx) => {
		// Boundary drafts are proposals until Pi journals them. Confirm the checkpoint
		// (or fallback note) before unlocking tools and clearing its progress widget.
		if (state.phase !== "watching") restore(ctx);
		if (state.phase === "watching") clearProgress();
		const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== GUIDANCE);
		const text = guidance(publish(ctx));
		if (text && hasMaterial(ctx))
			messages.push({ role: "custom", customType: GUIDANCE, content: text, display: false, timestamp: Date.now() });
		// Mutable guidance is appended after stable history, never inserted into the cached prefix.
		return { messages };
	});
	pi.on("message_end", (_event, ctx) => {
		publish(ctx);
	});
	pi.on("turn_end", (_event, ctx) => {
		publish(ctx);
	});
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed" || ctx.signal?.aborted || lifetime.signal.aborted) return;
		const scope = lifetime.signal;
		if (state.phase === "ready") {
			const handoff = state;
			await route(handoff.note, ctx);
			if (scope.aborted || ctx.signal?.aborted) return;
			return {
				entries: [
					{
						type: "custom_message" as const,
						customType: NOTE,
						content: handoff.note,
						display: false,
						details: { id: handoff.id },
					},
					{
						type: "custom" as const,
						customType: STATE,
						data: { phase: "watching", cycle: handoff.cycle + 1, nudged: false, forced: false },
					},
				],
				continue: true,
			};
		}
		if (state.phase !== "watching") {
			const handoff = state;
			if (!hasMaterial(ctx)) {
				state.phase = "failed";
				save();
				ctx.ui.notify(
					"Self-compaction has no material to summarize; the saved note remains pending. Use /compact to recover.",
					"warning",
				);
				return;
			}
			const signal = AbortSignal.any([scope, ...(ctx.signal ? [ctx.signal] : [])]);
			showProgress(ctx);
			signal.addEventListener("abort", clearProgress, { once: true });
			for (let attempt = 0; attempt < 3; attempt++) {
				state.phase = "compacting";
				save();
				publish(ctx);
				try {
					progress?.loader?.setMessage("Compacting context…");
					const result = await summarize(
						event.context.contextMessages,
						{ id: handoff.id, toolCallId: handoff.toolCallId, text: handoff.note },
						ctx,
						undefined,
						signal,
					);
					progress?.loader?.setMessage("Preparing handoff…");
					await route(handoff.note, ctx);
					signal.throwIfAborted();
					const entries: SessionBoundaryDraft[] = [
						{
							type: "compaction",
							summary: result.summary,
							firstKeptEntryId: null,
							details: result.details,
							usage: result.usage,
						},
						{
							type: "custom_message",
							customType: CONTINUE,
							content: RESUME,
							display: false,
							details: { id: handoff.id },
						},
						{
							type: "custom",
							customType: STATE,
							data: { phase: "watching", cycle: handoff.cycle + 1, nudged: false, forced: false },
						},
					];
					signal.removeEventListener("abort", clearProgress);
					lastLevel = "";
					return { entries, continue: true };
				} catch {
					// A tree/session switch already restored another branch's state.
					if (scope.aborted) return;
					state = { ...handoff, phase: "failed" };
					save();
					if (signal.aborted) {
						clearProgress();
						return;
					}
					if (attempt < 2) {
						try {
							await delay(2000 * (attempt + 1), undefined, { signal });
						} catch {
							clearProgress();
							return;
						}
					}
				}
			}
			signal.removeEventListener("abort", clearProgress);
			clearProgress();
			ctx.ui.notify(
				"Self-compaction failed after three attempts. Your note is saved and tools stay locked; the next run or /compact can retry.",
				"error",
			);
			return;
		}
		if (!settings.selfCompact.enabled || state.nudged || ctx.hasPendingMessages() || event.continue) return;
		const current = publish(ctx);
		if ((current.level === "warning" || current.level === "forced") && hasMaterial(ctx)) {
			state.nudged = true;
			return {
				entries: [
					{ type: "custom", customType: STATE, data: structuredClone(state) },
					{
						type: "custom_message",
						customType: GUIDANCE,
						content: `${guidance(current)}\nCompact now before continuing.`,
						display: false,
					},
				],
				continue: true,
			};
		}
	});
	// Native triggers share the checkpoint builder and keep Pi's own progress UI.
	pi.on("session_before_compact", async (event, ctx) => {
		clearProgress();
		const note = state.phase === "watching" ? null : state;
		const signal = AbortSignal.any([event.signal, lifetime.signal]);
		try {
			const result = await summarize(
				ctx.sessionManager.buildSessionProjection().messages,
				note ? { id: note.id, toolCallId: note.toolCallId, text: note.note } : null,
				ctx,
				event.customInstructions,
				signal,
			);
			signal.throwIfAborted();
			// The non-message anchor adapts the required string boundary in Pi's
			// native result without keeping any preceding raw conversation.
			pi.appendEntry("tau.compaction.anchor", { checkpointId: result.details.checkpointId });
			const firstKeptEntryId = ctx.sessionManager.getLeafId();
			if (!firstKeptEntryId) throw new Error("Compaction retention anchor was not journaled");
			return { compaction: { ...result, firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		} catch {
			if (signal.aborted) return { cancel: true };
			ctx.ui.notify("Tau checkpoint failed; trying Pi compaction.", "warning");
			// Pi remains the safety net for manual, threshold, and overflow recovery.
			return undefined;
		}
	});
	pi.on("session_compact", async (event, ctx) => {
		const scope = lifetime.signal;
		const note = state.phase === "watching" ? null : state;
		const details = event.compactionEntry.details as
			| { checkpointId?: string; handoffId?: string; handoff?: string }
			| undefined;
		const included = !!note && details?.handoffId === note.id;
		state =
			note && !included
				? { ...note, phase: "ready" }
				: { phase: "watching", cycle: state.cycle + 1, nudged: false, forced: false };
		save();
		if (!event.fromExtension)
			ctx.ui.notify("Tau checkpoint failed; used Pi compaction, recent history retained.", "warning");
		await route(
			details?.checkpointId
				? (details.handoff ?? note?.note ?? event.compactionEntry.summary)
				: (note?.note ?? event.compactionEntry.summary),
			ctx,
		);
		if (scope.aborted) return;
		if (note && (!included || !event.willRetry))
			pi.sendMessage(
				{
					customType: included ? CONTINUE : NOTE,
					content: included ? RESUME : note.note,
					display: false,
					details: { id: note.id },
				},
				{ triggerTurn: !event.willRetry },
			);
		lastLevel = "";
		publish(ctx);
	});
	pi.on("session_start", async (_event, ctx) => {
		lifetime.abort();
		clearProgress();
		lifetime = new AbortController();
		await refresh(ctx);
		restore(ctx);
		publish(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		lifetime.abort();
		clearProgress();
		lifetime = new AbortController();
		restore(ctx);
		publish(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await refresh(ctx);
		publish(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		publish(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		restore(ctx);
		clearProgress();
		publish(ctx);
	});
	pi.on("session_shutdown", () => {
		lifetime.abort();
		clearProgress();
	});
}
