import { type ThinkingLevel, type Tool, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getBranchInjectedContexts,
	getPendingInjectedContexts,
	type InjectedContext,
} from "../../shared/injected-context.ts";
import { generateToolValidated, resolveCandidates } from "../../shared/model-fallback/index.ts";
import { errorText, truncAt } from "../../shared/text.ts";

const STATUS_KEY = "auto-name";
const SENTINEL = "NONE";
const MAX_NAME_LENGTH = 80;
const MAX_NAMING_INPUT_CHARS = 120_000;
const AUTO_NAME_MODELS: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> = [
	{ provider: "openai-codex", model: "gpt-5.4-mini", reasoning: "medium" },
	{ provider: "openrouter", model: "cohere/north-mini-code:free", reasoning: "high" },
];

const NAMING_PROMPT = [
	"You are naming a chat session based on the user's first message and any injected hidden context.",
	"Your only job is to call the name_session tool exactly once.",
	"Do not write any text before or after the tool call. Do not answer in prose. Do not ask a follow-up question.",
	"Answer the question: what is this chat about?",
	"",
	"If injected context is present, treat it as primary; the user message may be generic command text.",
	"",
	"Rules:",
	"- A brief natural phrase that says what the work is about. Not a URL slug, not a keyword list.",
	"- If the work targets a specific named feature, component, or file in the repository, call it out by name.",
	"- A person scanning a session list a week later should know what this chat was about.",
	"- No quotes, no trailing punctuation, no markdown, no code fences.",
	'- No filler like "task:", "chat about", "working on".',
	"",
	'Good: "Improving auto-name model selection and prompt"',
	'Bad:  "automatic naming function and prompt improvement"',
	"",
	'Good: "Cleaning up old plan notes before commit"',
	'Bad:  "commit plan note and previous plan"',
	"",
	"The bad examples are keyword slugs — compressed word salads that tell you nothing about the actual work.",
	"",
	`- If the message is too short, ambiguous, a bare command, or has no clear topic, submit exactly: ${SENTINEL}`,
	"- Call name_session with the name only.",
].join("\n");
const NAME_SESSION_TOOL = {
	name: "name_session",
	description: "Submit the generated session name. This is the only allowed response.",
	parameters: Type.Object({
		name: Type.String({ description: `Session name, or exactly ${SENTINEL} when there is no clear topic.` }),
	}),
} satisfies Tool;

let generation = 0;
let activeController: AbortController | undefined;

export default function autoNameExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		const prompt = buildNamingInput(event.prompt, [
			...getBranchInjectedContexts(ctx.sessionManager.getBranch()),
			...getPendingInjectedContexts(),
		]);
		if (!prompt || pi.getSessionName()) return;

		const myGen = ++generation;
		activeController?.abort();
		const controller = new AbortController();
		activeController = controller;

		void runAutoName(pi, ctx, controller, myGen, prompt);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		generation++;
		activeController?.abort();
		activeController = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function runAutoName(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	controller: AbortController,
	myGen: number,
	prompt: string,
): Promise<void> {
	const ui = ctx.ui;
	try {
		const candidates = await resolveCandidates(ctx, AUTO_NAME_MODELS, true);
		const result = await generateToolValidated(
			{ ui, signal: controller.signal },
			candidates,
			`${NAMING_PROMPT}\n\n${prompt}`,
			NAME_SESSION_TOOL,
			nameResultFromToolInput,
			(error, text) =>
				[
					`That session name failed validation: ${error.message}`,
					`Call ${NAME_SESSION_TOOL.name} again with corrected arguments only.`,
					"Previous response:",
					text,
				].join("\n"),
			{ statusKey: STATUS_KEY, notifyOnFallback: false, maxAttempts: 3 },
		);

		if (controller.signal.aborted || myGen !== generation) return;
		if (!result.name) return;
		if (pi.getSessionName()) return;

		pi.setSessionName(result.name);
		ui.notify(`Session named: ${result.name}`, "info");
	} catch (error) {
		if (!controller.signal.aborted && myGen === generation) {
			ui.notify(`Session naming failed: ${errorText(error)}`, "error");
		}
	} finally {
		if (activeController === controller) {
			activeController = undefined;
			ui.setStatus(STATUS_KEY, undefined);
		}
	}
}

function buildNamingInput(userMessage: string, contexts: readonly InjectedContext[]): string {
	const prompt = userMessage.trim();
	if (!prompt && contexts.length === 0) return "";

	const parts = [
		"User message:",
		prompt || "(none)",
		...contexts.flatMap((context, index) => [
			"",
			`Injected context ${index + 1}: ${context.details.title ?? context.details.source}`,
			truncAt(context.content, MAX_NAMING_INPUT_CHARS),
		]),
	];
	return truncAt(parts.join("\n"), MAX_NAMING_INPUT_CHARS);
}

interface NameResult {
	name: string | null;
}

function nameResultFromToolInput(input: unknown): NameResult {
	if (!isNameSessionToolInput(input)) throw new Error("Session name tool input is malformed.");
	return validateName(input.name);
}

function isNameSessionToolInput(input: unknown): input is { name: string } {
	return typeof input === "object" && input !== null && "name" in input && typeof input.name === "string";
}

function validateName(text: string): NameResult {
	const name = text
		.trim()
		.replace(/^["'\s]+|["'\s]+$/g, "")
		.replace(/[.`]+$/g, "")
		.trim()
		.slice(0, MAX_NAME_LENGTH);
	if (!name || name.toUpperCase() === SENTINEL) return { name: null };
	return { name };
}
