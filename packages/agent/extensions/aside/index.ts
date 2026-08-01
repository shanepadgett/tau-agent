import { randomUUID } from "node:crypto";
import type { Context, Message, Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorText } from "../../shared/text.ts";
import { AsideResultPanel, AsideWidget, type AsideResult } from "./panel.ts";

const WIDGET_KEY = "aside";
const CURRENT_CONVERSATION = "Current conversation branch";
const NO_CONTEXT = "No context";

function buildAsideRequest(messages: readonly Message[], question: string, systemPrompt: string | undefined): Context {
	const toolResults = new Set(
		messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
	);
	let validLength = messages.length;
	for (const [index, message] of messages.entries()) {
		if (
			message.role === "assistant" &&
			message.content.some((part) => part.type === "toolCall" && !toolResults.has(part.id))
		) {
			validLength = index;
			break;
		}
	}

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	};
	const request = { messages: [...messages.slice(0, validLength), userMessage] };
	return systemPrompt === undefined ? request : { ...request, systemPrompt };
}

export default function asideExtension(pi: ExtensionAPI): void {
	let activeController: AbortController | undefined;
	let latest: AsideResult | undefined;
	let generation = 0;

	const setWidget = (ctx: ExtensionContext, question: string | undefined): void => {
		ctx.ui.setWidget(WIDGET_KEY, question ? (_tui, theme) => new AsideWidget(theme, question) : undefined, {
			placement: "aboveEditor",
		});
	};

	const clear = (ctx: ExtensionContext): void => {
		generation += 1;
		activeController?.abort();
		activeController = undefined;
		latest = undefined;
		setWidget(ctx, undefined);
	};

	pi.on("session_start", (_event, ctx) => clear(ctx));
	pi.on("session_shutdown", (_event, ctx) => clear(ctx));

	pi.registerCommand("aside", {
		description: "Ask the current model a side question outside the transcript",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/aside requires TUI mode", "warning");
				return;
			}

			const question = args.trim();
			if (question === "clear") {
				clear(ctx);
				return;
			}
			if (!question) {
				if (!latest) {
					ctx.ui.notify(activeController ? "Aside is still running" : "No aside answer available", "info");
					return;
				}
				await showResult(ctx, latest);
				return;
			}
			if (activeController) {
				ctx.ui.notify("An aside is already running", "warning");
				return;
			}

			const contextChoice = await ctx.ui.select("Aside context", [CURRENT_CONVERSATION, NO_CONTEXT]);
			if (!contextChoice) return;
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const controller = new AbortController();
			activeController = controller;
			const requestGeneration = ++generation;
			setWidget(ctx, question);
			void runAside(ctx, model, question, contextChoice === CURRENT_CONVERSATION, controller.signal)
				.then((result) => {
					if (generation !== requestGeneration || controller.signal.aborted) return;
					latest = result;
					activeController = undefined;
					setWidget(ctx, undefined);
					void showResult(ctx, result).catch((error: unknown) => {
						if (generation !== requestGeneration) return;
						ctx.ui.notify(`Could not open aside: ${errorText(error)}`, "error");
					});
				})
				.catch((error: unknown) => {
					if (generation !== requestGeneration || controller.signal.aborted) return;
					setWidget(ctx, undefined);
					ctx.ui.notify(`Aside failed: ${errorText(error)}`, "error");
				})
				.finally(() => {
					if (generation === requestGeneration) activeController = undefined;
				});
		},
	});
}

async function runAside(
	ctx: ExtensionCommandContext,
	model: Model<string>,
	question: string,
	withConversation: boolean,
	signal: AbortSignal,
): Promise<AsideResult> {
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) throw new Error(`Provider ${model.provider} is unavailable`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	const request = withConversation
		? buildAsideRequest(
				convertToLlm(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages),
				question,
				ctx.getSystemPrompt(),
			)
		: buildAsideRequest([], question, undefined);
	const response = await provider
		.streamSimple(model, request, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal,
			reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
			sessionId: withConversation ? ctx.sessionManager.getSessionId() : randomUUID(),
		})
		.result();
	if (response.stopReason === "error") throw new Error(response.errorMessage || "model returned an error");
	if (response.stopReason === "aborted") throw new Error("Cancelled");
	const answer = response.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();
	if (!answer) throw new Error("model returned no text");
	return { question, answer, context: withConversation ? CURRENT_CONVERSATION : NO_CONTEXT };
}

async function showResult(ctx: ExtensionCommandContext, result: AsideResult): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keys, done) => new AsideResultPanel(tui, theme, keys, result, done), {
		overlay: true,
		overlayOptions: { anchor: "top-center", width: "80%", minWidth: 68, maxHeight: "90%", margin: 1 },
	});
}
