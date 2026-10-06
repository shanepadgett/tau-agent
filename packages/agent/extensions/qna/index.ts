import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { emitAgentBlocked } from "../../shared/agent-blocked.ts";
import { BoundedTextResultBuilder, type BoundedTextOverflowDetails } from "../../shared/bounded-text-result.ts";
import { createTemporaryOutputStore, type TemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { normalizeParams, type QnaParams, type QnaResult } from "./model.ts";
import { runQnaUi } from "./ui.ts";

const TOOL_ASK_QUESTION = "ask_question";

type QnaToolDetails = QnaResult & { overflow: BoundedTextOverflowDetails };

const optionSchema = Type.Object(
	{
		value: Type.String({ minLength: 1, description: "Unique option value; use this, not label, in recommendations" }),
		label: Type.String({ minLength: 1, description: "Short user-facing option label" }),
	},
	{ additionalProperties: false },
);

const recommendationSchema = Type.Object(
	{
		values: Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			uniqueItems: true,
			description:
				"select: one option value; multi: one or more option values; confirm: one of 'yes'/'no'; input: one suggested text answer",
		}),
		reason: Type.String({ minLength: 1, description: "Honest tradeoff-based justification" }),
	},
	{ additionalProperties: false },
);

const askQuestionParamsSchema = Type.Object(
	{
		title: Type.Optional(Type.String({ description: "Short title for the question panel" })),
		questions: Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1, description: "Unique question id; also used as the tab label" }),
					prompt: Type.String({ minLength: 1, description: "Question shown to the user" }),
					kind: StringEnum(["select", "multi", "input", "confirm"] as const, {
						description:
							"select: one choice; multi: combinable choices; input: typed answer; confirm: fixed yes/no",
					}),
					options: Type.Optional(
						Type.Array(optionSchema, {
							minItems: 1,
							description: "Required for select/multi; omit for input/confirm",
						}),
					),
					recommendation: Type.Optional(recommendationSchema),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, description: "Focused questions. Prefer 1-3." },
		),
	},
	{ additionalProperties: false },
);

const QNA_PROMPT = `Use ask_question to re-ask your last question or set of questions. Improve weak wording or options using existing context; inspect files only if needed. Do not answer for the user. If there is no question to re-ask, say so without using tools.`;

function buildQnaPrompt(context: string): string {
	const trimmed = context.trim();
	if (!trimmed) return QNA_PROMPT;
	return `${QNA_PROMPT}

Additional user context for framing the question:
${trimmed}`;
}

function createAskQuestionTool(pi: ExtensionAPI, temporaryOutput: TemporaryOutputStore) {
	return defineTool<typeof askQuestionParamsSchema, QnaToolDetails>({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Re-ask the user's pending questions through structured UI when they invoke /qna. Submit all questions in one call; recommendations are optional.",
		promptSnippet: "Structured question UI for /qna",
		promptGuidelines: [
			"For ask_question, ask only the pending user decisions, not routine chat or questions answerable from files. Prefer 1-3 focused questions.",
			"Choices must cover the real decision space: no filler, strawmen, jokes, or bad decoys. Do not force a fixed option count or rely on custom answers to cover missing choices; use input when choices would be fake.",
			"Write choices before recommending. Include recommendation only when you have a real one; explain its tradeoff honestly, without steering through weak alternatives.",
			"Do not add custom-answer options or catch-all context questions; ask_question provides custom answers for select/multi and a final Additional Context tab.",
		],
		parameters: askQuestionParamsSchema,
		exposure: "model-only",
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questions = normalizeParams(params);
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.abort();
				throw new Error("ask_question aborted: interactive UI unavailable");
			}

			ctx.ui.setWorkingVisible(false);
			try {
				emitAgentBlocked(pi, {
					title: params.title || "Tau",
					body: "Waiting for your answer",
					source: "qna.ask_question",
				});
				const result = await ctx.ui.custom<QnaResult | undefined>((tui, theme, _keybindings, done) =>
					runQnaUi(tui, theme, params.title, questions, done),
				);
				if (!result) {
					ctx.abort();
					throw new Error("ask_question aborted by user");
				}
				const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
				try {
					for (const [index, answer] of Object.values(result.answers).entries()) {
						signal?.throwIfAborted();
						await builder.appendBlock(
							undefined,
							`Question ${index + 1}`,
							formatAnswer(answer, index, (text) => text),
						);
					}
					const additionalContext = result.additionalContext?.trim();
					if (additionalContext) {
						await builder.appendBlock(
							undefined,
							"Additional context",
							`Additional context:\n${additionalContext}`,
						);
					}
					signal?.throwIfAborted();
					const bounded = await builder.finish();
					return {
						content: [{ type: "text", text: bounded.content }],
						details: { ...result, overflow: bounded.overflow },
					};
				} catch (error) {
					await builder.abort();
					throw error;
				}
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
			if (!details) {
				const text = result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				return new Text(theme.fg("warning", text || "ask_question returned no details"), 0, 0);
			}
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
	const temporaryOutput = createTemporaryOutputStore();

	function syncQnaTools(): void {
		const active = new Set(pi.getActiveTools());
		if (qnaActive) active.add(TOOL_ASK_QUESTION);
		else active.delete(TOOL_ASK_QUESTION);
		pi.setActiveTools([...active]);
	}

	pi.registerTool(createAskQuestionTool(pi, temporaryOutput));

	pi.on("session_start", async () => {
		qnaActive = false;
		syncQnaTools();
		await temporaryOutput.shutdown();
		await temporaryOutput.start();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== TOOL_ASK_QUESTION || event.isError) return;
		qnaActive = false;
		syncQnaTools();
	});
	pi.on("agent_end", () => {
		qnaActive = false;
		syncQnaTools();
	});
	pi.on("session_shutdown", async () => {
		await temporaryOutput.shutdown();
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
