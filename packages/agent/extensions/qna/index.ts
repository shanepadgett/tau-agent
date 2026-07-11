import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { emitAgentBlocked } from "../../shared/agent-blocked.ts";
import { normalizeParams, type QnaParams, type QnaResult } from "./model.ts";
import { runQnaUi } from "./ui.ts";

const TOOL_ASK_QUESTION = "ask_question";

const optionSchema = Type.Object({
	value: Type.String({ description: "Stable option value returned in result" }),
	label: Type.String({ description: "Short user-facing option label" }),
});

const recommendationSchema = Type.Object({
	values: Type.Array(Type.String(), { description: "Recommended option values, chosen after options are written" }),
	reason: Type.String({ description: "Honest tradeoff-based justification for recommendation" }),
});

const askQuestionParamsSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Short title for the question panel" })),
	questions: Type.Array(
		Type.Object({
			id: Type.String({ description: "Unique question id" }),
			prompt: Type.String({ description: "Question shown to the user" }),
			kind: StringEnum(["select", "multi", "input", "confirm"] as const, {
				description: "select: one choice; multi: several choices; input: typed answer; confirm: yes/no",
			}),
			options: Type.Optional(
				Type.Array(optionSchema, { description: "Required for select/multi, forbidden for input/confirm" }),
			),
			recommendation: Type.Optional(recommendationSchema),
		}),
		{ description: "Focused questions. Prefer 1-3." },
	),
});

const QNA_PROMPT = `Use ask_question to re-ask the question you just asked the user.

Do not blindly copy your previous wording or options. Reframe the question if needed so it follows ask_question quality rules:
- options must be real, valid, defensible choices
- do not include filler, strawmen, joke options, bad decoys, or preferred answer plus trash
- use as many options as the real decision space needs: 2 is fine, 10 is fine, 3 is not special
- if your previous options were weak, replace them
- ground the reframed question in existing context; inspect repo or docs first only when current context is not enough
- use select for one choice, multi for combinable choices, confirm for yes/no, input when choices would be fake
- include recommendation only when you have a real one, with honest tradeoff reason
- do not include a catch-all additional-context question; the UI always provides a final optional Additional Context tab
- do not answer the question yourself
- if there is no question to re-ask, say so without using tools`;

function buildQnaPrompt(context: string): string {
	const trimmed = context.trim();
	if (!trimmed) return QNA_PROMPT;
	return `${QNA_PROMPT}

Additional user context for framing the question:
${trimmed}`;
}

function createAskQuestionTool(pi: ExtensionAPI) {
	return defineTool<typeof askQuestionParamsSchema, QnaResult>({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Ask user structured question only when missing intent, preference, or constraint blocks progress. Supports select, multi-select, yes/no, and free-form input. Choices must be real, valid, non-filler. Selectable questions require recommendation values plus honest reason after options. Do not use for routine chat, obvious choices, or avoidable analysis.",
		promptSnippet:
			"Ask structured questions only when a real user decision blocks progress; every choice must be valid, defensible, non-filler.",
		promptGuidelines: [
			"Use ask_question only when missing user intent, preference, or constraint would materially change next action.",
			"Do not use ask_question for routine chat, status updates, obvious decisions, or questions answerable from files/instructions.",
			"If one path is clearly correct, do not use ask_question. Proceed and state assumption briefly.",
			"When using ask_question choices, every option must be real, valid, and defensible. No filler, strawmen, joke options, bad decoys, or preferred answer plus junk.",
			"When using ask_question choices, cover realistic decision space. Custom answer is safety valve, not excuse for weak options.",
			"For ask_question select, multi-select, confirm, and recommended input: write options or suggested answer first, then recommendation values, then recommendation reason.",
			"ask_question recommendation reason must explain tradeoff honestly. Do not manipulate user toward fake-obvious answer.",
			"Use ask_question multi-select only when combining options is valid. Use select for one path. Use confirm for yes/no. Use input when choices would be fake; include an input recommendation only when you have a real suggested answer.",
			"Ask fewest questions that unblock work. Prefer 1-3 focused questions. No surveys.",
			"Do not add catch-all or additional-context questions; the UI always provides a final optional Additional Context tab.",
		],
		parameters: askQuestionParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const castParams = params as QnaParams;
			const questions = normalizeParams(castParams);
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.abort();
				throw new Error("ask_question aborted: interactive UI unavailable");
			}

			ctx.ui.setWorkingVisible(false);
			try {
				emitAgentBlocked(pi, {
					title: castParams.title || "Tau",
					body: "Waiting for your answer",
					source: "qna.ask_question",
				});
				const result = await ctx.ui.custom<QnaResult | undefined>((tui, theme, _keybindings, done) =>
					runQnaUi(tui, theme, castParams.title, questions, done),
				);
				if (!result) {
					ctx.abort();
					throw new Error("ask_question aborted by user");
				}
				return {
					content: [{ type: "text", text: formatResult(result) }],
					details: result,
				};
			} finally {
				ctx.ui.setWorkingVisible(true);
			}
		},

		renderCall(args, theme) {
			const params = args as QnaParams;
			const count = Array.isArray(params.questions) ? params.questions.length : 0;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ask_question"))} ${theme.fg("muted", params.title || `${count} question${count === 1 ? "" : "s"}`)}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details) return new Text(theme.fg("warning", "ask_question returned no details"), 0, 0);
			return new Text(
				formatResult(details, (text) => theme.bold(text)),
				0,
				0,
			);
		},
	});
}

export default function qnaExtension(pi: ExtensionAPI): void {
	let qnaActive = false;

	function syncQnaTools(): void {
		const active = new Set(pi.getActiveTools());
		if (qnaActive) active.add(TOOL_ASK_QUESTION);
		else active.delete(TOOL_ASK_QUESTION);
		pi.setActiveTools([...active]);
	}

	pi.registerTool(createAskQuestionTool(pi));

	pi.on("session_start", () => {
		qnaActive = false;
		syncQnaTools();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== TOOL_ASK_QUESTION) return;
		qnaActive = false;
		syncQnaTools();
	});
	pi.on("agent_end", () => {
		qnaActive = false;
		syncQnaTools();
	});

	pi.registerCommand("qna", {
		description:
			"Ask the agent to re-ask its last question with structured choices. Optional text is framing context.",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}

			qnaActive = true;
			syncQnaTools();
			pi.sendMessage(
				{ customType: "tau.qna", content: buildQnaPrompt(args), display: false },
				{ triggerTurn: true },
			);
		},
	});
}

function formatResult(result: QnaResult, formatLabel: (text: string) => string = (text) => text): string {
	const sections = [
		Object.values(result.answers)
			.map((answer, index) => formatAnswer(answer, index, formatLabel))
			.join("\n\n"),
	];
	const additionalContext = result.additionalContext?.trim();
	if (additionalContext) sections.push(`${formatLabel("Additional context:")}\n${additionalContext}`);
	return `\n${sections.join("\n\n")}`;
}

function formatAnswer(
	answer: QnaResult["answers"][string],
	index: number,
	formatLabel: (text: string) => string,
): string {
	if (answer.kind !== "multi") {
		return [
			`${index + 1}. ${formatLabel(answer.prompt)}`,
			...formatRecommendation(answer, formatLabel),
			formatSingleAnswer(answer, formatLabel),
		].join("\n");
	}

	return [
		`${index + 1}. ${formatLabel(answer.prompt)}`,
		...formatRecommendation(answer, formatLabel),
		`   ${formatLabel("Answer:")}`,
		formatMultiAnswer(answer),
	].join("\n");
}

function formatRecommendation(answer: QnaResult["answers"][string], formatLabel: (text: string) => string): string[] {
	if (!answer.recommendation) return [];
	const recommendation = answer.recommendation.labels;
	return [
		...(recommendation.length === 1
			? [`   ${formatLabel("Recommendation:")} ${recommendation[0]}`]
			: [`   ${formatLabel("Recommendation:")}`, ...recommendation.map((label) => `   - ${label}`)]),
		`   ${formatLabel("Reason:")} ${answer.recommendation.reason}`,
	];
}

function formatSingleAnswer(answer: QnaResult["answers"][string], formatLabel: (text: string) => string): string {
	const value = answer.kind === "input" ? answer.input : answer.labels[0];
	const answerLine = `   ${formatLabel("Answer:")} ${value || "_Skipped_"}`;
	return [answerLine, ...formatNotes(answer, "   ", answer.values[0])].join("\n");
}

function formatMultiAnswer(answer: QnaResult["answers"][string]): string {
	if (answer.labels.length === 0) return "   _Skipped_";
	return answer.labels
		.map((label, index) => [`   - ${label}`, ...formatNotes(answer, "     ", answer.values[index])].join("\n"))
		.join("\n");
}

function formatNotes(answer: QnaResult["answers"][string], indent: string, value?: string): string[] {
	const notes = value
		? answer.optionNotes?.[value]
			? [answer.optionNotes[value]]
			: []
		: Object.values(answer.optionNotes ?? {});
	return notes.flatMap((note) => note.split("\n").map((line) => `${indent}└─ ${line}`));
}
