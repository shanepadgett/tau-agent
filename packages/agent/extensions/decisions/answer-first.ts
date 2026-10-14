import type { ClassifierQuestion } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionClient, DecisionResult } from "../../shared/decisions.ts";

const KIND: ClassifierQuestion = {
	type: "choice",
	instructions: "What is the user's prompt to the coding agent asking for?",
	criteria: {
		question:
			"Information, an explanation, an opinion or recommendation, whether something is possible or advisable (is there a way, could we, should we, why), or confirmation that the agent understood, with no work requested",
		question_and_work:
			"A real question, an understanding check, or pushback phrased as a question, together with requested work",
		hold: "Asks the agent to hold off, not start yet, or wait until decisions are agreed",
		work: "Work only, including polite requests phrased as questions (can you run the tests?) or answer then go ahead",
		continue:
			"Approval, an answer, or a continuation of the agent's proposal (yes, go ahead), or ideas and decisions shared without asking anything",
	},
};
const UNANSWERED: ClassifierQuestion = {
	type: "bool",
	instructions: "Did the agent's previous message ask the user questions that this prompt leaves unanswered?",
	criteria: {
		true: "The previous message asked one or more questions or asked for decisions, and the prompt answers only some or none of them",
		false: "No questions were asked; the prompt answers all of them; the prompt explicitly sets them aside; or the prompt changes direction so they no longer apply",
	},
};

export function registerAnswerFirst(pi: ExtensionAPI, client: DecisionClient): void {
	let pending: { prompt: string; previous: string; result: Promise<DecisionResult> } | undefined;
	function classify(prompt: string, ctx: ExtensionContext) {
		let previous = "";
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if (entry.type === "compaction") break;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			previous = entry.message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.slice(-3000);
			if (previous) break;
		}
		const questions: Record<string, ClassifierQuestion> = { kind: KIND };
		if (previous.includes("?")) questions.unanswered = UNANSWERED;
		return {
			prompt,
			previous,
			result: client.classify("answerFirst", ctx, { previous_agent_message_end: previous, prompt }, questions),
		};
	}
	pi.on("input", (event, ctx) => {
		pending = undefined;
		if (
			event.source !== "interactive" ||
			!ctx.isIdle() ||
			event.streamingBehavior ||
			event.text.startsWith("/") ||
			!client.enabled("answerFirst")
		)
			return;
		pending = classify(event.text, ctx);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const request = pending;
		pending = undefined;
		if (!("prompt" in event)) return;
		if (!request || !client.enabled("answerFirst")) return;
		const result = await (request.prompt === event.prompt ? request : classify(event.prompt, ctx)).result;
		if (result.status !== "ok" || ctx.signal?.aborted) return;
		const kind = result.answers.kind;
		const unanswered = result.answers.unanswered;
		const parts: string[] = [];
		if (
			kind?.type === "choice" &&
			(kind.probabilities.question ?? 0) +
				(kind.probabilities.question_and_work ?? 0) +
				(kind.probabilities.hold ?? 0) >=
				0.5
		) {
			parts.push(
				"The user's message asks a question or asks you to hold off. Answer first.\nYou may read files and run read-only commands to answer accurately.\nDo not edit files, run state-changing commands, or start the requested work.\nEnd with one line saying what you would do next, then stop and wait.",
			);
		}
		if (unanswered?.type === "bool" && unanswered.probability >= 0.5)
			parts.push(
				"Your previous message asked questions the user has not answered yet.\nAt the end of your reply, ask the unanswered ones again.",
			);
		if (parts.length)
			return { message: { customType: "tau.answer-first", content: parts.join("\n\n"), display: false } };
	});
	pi.on("session_start", () => {
		pending = undefined;
	});
	pi.on("session_shutdown", () => {
		pending = undefined;
	});
}
