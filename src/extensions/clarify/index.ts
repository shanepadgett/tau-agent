import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { buildResult, type ClarifyParams, type ClarifyResult, createState, normalizeParams } from "./model.ts";
import { runClarifyUi } from "./ui.ts";

const optionSchema = Type.Object({
	value: Type.String({ description: "Stable option value returned in result" }),
	label: Type.String({ description: "Short user-facing option label" }),
	description: Type.Optional(Type.String({ description: "When this option makes sense" })),
});

const recommendationSchema = Type.Object({
	values: Type.Array(Type.String(), { description: "Recommended option values, chosen after options are written" }),
	reason: Type.String({ description: "Honest tradeoff-based justification for recommendation" }),
});

const clarifyParamsSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Short title for the clarification panel" })),
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
		{ description: "Focused clarification questions. Prefer 1-3." },
	),
});

const clarifyTool = defineTool<typeof clarifyParamsSchema, ClarifyResult>({
	name: "clarify",
	label: "Clarify",
	description:
		"Ask user structured clarification only when missing intent, preference, or constraint blocks progress. Supports select, multi-select, yes/no, and free-form input. Choices must be real, valid, non-filler. Selectable questions require recommendation values plus honest reason after options. Do not use for routine chat, obvious choices, or avoidable analysis.",
	promptSnippet:
		"Ask structured clarification only when a real user decision blocks progress; every choice must be valid, defensible, non-filler.",
	promptGuidelines: [
		"Use clarify only when missing user intent, preference, or constraint would materially change next action.",
		"Do not use clarify for routine chat, status updates, obvious decisions, or questions answerable from files/instructions.",
		"If one path is clearly correct, do not use clarify. Proceed and state assumption briefly.",
		"When using clarify choices, every option must be real, valid, and defensible. No filler, strawmen, joke options, bad decoys, or preferred answer plus junk.",
		"When using clarify choices, cover realistic decision space. Custom answer is safety valve, not excuse for weak options.",
		"For non-trivial clarify options, include concise description explaining when option makes sense.",
		"For clarify select, multi-select, and confirm: write options first, then recommendation values, then recommendation reason.",
		"clarify recommendation reason must explain tradeoff honestly. Do not manipulate user toward fake-obvious answer.",
		"Use clarify multi-select only when combining options is valid. Use select for one path. Use confirm for yes/no. Use input when choices would be fake.",
		"Ask fewest clarify questions that unblock work. Prefer 1-3 focused questions. No surveys.",
	],
	parameters: clarifyParamsSchema,
	executionMode: "sequential",

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const castParams = params as ClarifyParams;
		const questions = normalizeParams(castParams);
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.abort();
			throw new Error("clarify aborted: interactive UI unavailable");
		}

		ctx.ui.setWorkingVisible(false);
		try {
			const result = await ctx.ui.custom<ClarifyResult | undefined>((tui, theme, _keybindings, done) =>
				runClarifyUi(tui, theme, castParams.title, questions, done),
			);
			if (!result) {
				ctx.abort();
				throw new Error("clarify aborted by user");
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
		const params = args as ClarifyParams;
		const count = Array.isArray(params.questions) ? params.questions.length : 0;
		return new Text(
			`${theme.fg("toolTitle", theme.bold("clarify"))} ${theme.fg("muted", params.title || `${count} question${count === 1 ? "" : "s"}`)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme) {
		const details = result.details;
		if (!details) return new Text(theme.fg("warning", "clarify returned no details"), 0, 0);
		return new Text(
			formatResult(details, (text) => theme.bold(text)),
			0,
			0,
		);
	},
});

export default function clarifyExtension(pi: ExtensionAPI): void {
	pi.registerTool(clarifyTool);
}

function formatResult(result: ClarifyResult, formatPrompt: (prompt: string) => string = (prompt) => prompt): string {
	return `\n${Object.values(result.answers)
		.map((answer, index) => formatAnswer(answer, index, formatPrompt))
		.join("\n\n")}`;
}

function formatAnswer(
	answer: ClarifyResult["answers"][string],
	index: number,
	formatPrompt: (prompt: string) => string,
): string {
	const body = answer.kind === "multi" ? formatMultiAnswer(answer) : formatSingleAnswer(answer);
	return `${index + 1}. ${formatPrompt(answer.prompt)}\n${body}`;
}

function formatSingleAnswer(answer: ClarifyResult["answers"][string]): string {
	const value = answer.kind === "input" ? answer.input : answer.labels[0];
	if (!value) return "   _Skipped_";
	return [`   ${value}`, ...formatNotes(answer, "   ")].join("\n");
}

function formatMultiAnswer(answer: ClarifyResult["answers"][string]): string {
	if (answer.labels.length === 0) return "   _Skipped_";
	return answer.labels
		.map((label, index) => [`   - ${label}`, ...formatNotes(answer, "     ", answer.values[index])].join("\n"))
		.join("\n");
}

function formatNotes(answer: ClarifyResult["answers"][string], indent: string, value?: string): string[] {
	const notes = value
		? answer.optionNotes?.[value]
			? [answer.optionNotes[value]]
			: []
		: Object.values(answer.optionNotes ?? {});
	return notes.flatMap((note) => note.split("\n").map((line) => `${indent}> ${line}`));
}

// ponytail: validates/result-builds without TUI harness; real UI needs Pi runtime.
function demo(): void {
	const questions = normalizeParams({
		questions: [
			{ id: "ship", prompt: "Ship?", kind: "confirm", recommendation: { values: ["yes"], reason: "Ready." } },
		],
	});
	const state = buildResult(createState(undefined, questions));
	if (state.answers.ship?.kind !== "confirm") throw new Error("clarify demo failed");
	if (!formatResult(state).startsWith("\n1. Ship?")) throw new Error("clarify format failed");
}

if (process.argv[1]?.endsWith("src/extensions/clarify/index.ts")) demo();
