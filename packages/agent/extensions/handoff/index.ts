import { randomUUID } from "node:crypto";
import {
	BorderedLoader,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { generateToolValidated, resolveCandidates } from "../../shared/model-fallback/index.ts";
import { errorText } from "../../shared/text.ts";
import { prepareFileInjection } from "@shanepadgett/tau-agent";
import { buildHandoffRequest, type HandoffDraft, handoffDraftFromToolInput, HANDOFF_TOOL } from "./model.ts";

export default function handoffExtension(pi: ExtensionAPI): void {
	pi.registerCommand("handoff", {
		description: "Start a fresh chat with a generated prompt and autoread files",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/handoff requires TUI mode.", "error");
				return;
			}
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for the new chat>", "error");
				return;
			}
			await ctx.waitForIdle();
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected.", "error");
				return;
			}
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			if (!currentSessionFile) {
				ctx.ui.notify("The current session must be persisted before handoff.", "error");
				return;
			}
			const messages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
			if (messages.length === 0) {
				ctx.ui.notify("No conversation context to hand off.", "error");
				return;
			}

			let generationError: string | undefined;
			const draft = await ctx.ui.custom<HandoffDraft | null>((tui, theme, _keys, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating handoff");
				loader.onAbort = () => done(null);
				void (async () => {
					try {
						const thinking = pi.getThinkingLevel();
						const candidates = await resolveCandidates(
							ctx,
							[
								{
									provider: model.provider,
									model: model.id,
									reasoning: thinking === "off" ? undefined : thinking,
								},
							],
							false,
						);
						const conversation = serializeConversation(convertToLlm(messages));
						const result = await generateToolValidated(
							{ ui: ctx.ui, signal: loader.signal },
							candidates,
							buildHandoffRequest(conversation, goal, ctx.cwd),
							HANDOFF_TOOL,
							handoffDraftFromToolInput,
							(error, output) =>
								[
									`The handoff failed validation: ${error.message}`,
									`Call ${HANDOFF_TOOL.name} again with corrected arguments only.`,
									"Previous response:",
									output,
								].join("\n"),
							{ maxAttempts: 3 },
						);
						done(result);
					} catch (error) {
						if (!loader.signal.aborted) generationError = errorText(error);
						done(null);
					}
				})();
				return loader;
			});

			if (!draft) {
				ctx.ui.notify(
					generationError ? `Handoff failed: ${generationError}` : "Handoff cancelled.",
					generationError ? "error" : "info",
				);
				return;
			}

			const fileMessages = await prepareFileInjection(pi, {
				cwd: ctx.cwd,
				source: "handoff",
				batchId: randomUUID(),
				files: draft.files.map((path) => ({ path, mode: "full" as const })),
			});
			const result = await ctx.newSession({
				parentSession: currentSessionFile,
				setup: async (sessionManager) => {
					for (const message of fileMessages) {
						sessionManager.appendCustomMessageEntry(
							message.customType,
							message.content,
							message.display,
							message.details,
						);
					}
				},
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(draft.prompt);
					replacementCtx.ui.notify("Handoff ready. Review the draft and submit when ready.", "info");
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("New session cancelled.", "info");
			}
		},
	});
}
