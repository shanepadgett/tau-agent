import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getBranchInjectedContexts,
	getPendingInjectedContexts,
	type InjectedContext,
} from "../../shared/injected-context.ts";
import { generateValidated, resolveCandidates } from "../../shared/model-fallback/index.ts";
import { truncAt } from "../../shared/text.ts";

const STATUS_KEY = "auto-name";
const SENTINEL = "NONE";
const MAX_NAME_LENGTH = 80;
const MAX_NAMING_INPUT_CHARS = 120_000;

const NAMING_PROMPT = [
	"You are naming a chat session based on the user's first message and any injected hidden context.",
	"Return a single short, descriptive session name that captures what the work is about.",
	"If injected context is present, treat it as primary; the user message may be generic command text.",
	"Rules:",
	"- Plain text, no quotes, no punctuation at the end, no markdown, no code fences.",
	'- 3-8 words. Lowercase unless a proper noun. No filler like "task:" or "chat about".',
	'- Focus on the concrete subject, not the action ("auth token refresh" not "fix the bug").',
	`- If the message is too short, ambiguous, a bare command, or has no clear topic, respond with exactly: ${SENTINEL}`,
	"- Respond with the name only, nothing else.",
].join("\n");

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
	try {
		const candidates = (await resolveCandidates(ctx)).map((candidate) => ({
			...candidate,
			reasoning: "low" as const,
		}));
		const result = await generateValidated(
			{ ui: ctx.ui, signal: controller.signal },
			candidates,
			`${NAMING_PROMPT}\n\n${prompt}`,
			validateName,
			undefined,
			{ statusKey: STATUS_KEY, notifyOnFallback: false },
		);

		if (controller.signal.aborted || myGen !== generation) return;
		if (!result.name) return;
		if (pi.getSessionName()) return;

		pi.setSessionName(result.name);
		ctx.ui.notify(`Session named: ${result.name}`, "info");
	} catch {
		// Background naming is best-effort; never surface failures to the user.
	} finally {
		if (activeController === controller) {
			activeController = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
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
