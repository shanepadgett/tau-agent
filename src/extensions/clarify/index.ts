import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { buildResult, type ClarifyParams, type ClarifyResult, createState, normalizeParams } from "./model.ts";
import { runClarifyUi } from "./ui.ts";

const TOOL_CLARIFY = "clarify";
const TOOL_INTERVIEW_END = "interview_end";

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

const QNA_PROMPT = `Use clarify to re-ask the question you just asked the user.

Do not blindly copy your previous wording or options. Reframe the question if needed so it follows clarify quality rules:
- options must be real, valid, defensible choices
- do not include filler, strawmen, joke options, bad decoys, or preferred answer plus trash
- use as many options as the real decision space needs: 2 is fine, 10 is fine, 3 is not special
- if your previous options were weak, replace them
- ground the reframed question in existing context; inspect repo or docs first only when current context is not enough
- use select for one choice, multi for combinable choices, confirm for yes/no, input when choices would be fake
- include recommendation only when you have a real one, with honest tradeoff reason
- do not answer the question yourself
- if there is no question to re-ask, say so without using tools`;

const interviewEndParamsSchema = Type.Object({
	finalNote: Type.Optional(Type.String({ description: "Optional short note about why the interview is complete" })),
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
		"For clarify select, multi-select, confirm, and recommended input: write options or suggested answer first, then recommendation values, then recommendation reason.",
		"clarify recommendation reason must explain tradeoff honestly. Do not manipulate user toward fake-obvious answer.",
		"Use clarify multi-select only when combining options is valid. Use select for one path. Use confirm for yes/no. Use input when choices would be fake; include an input recommendation only when you have a real suggested answer.",
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
	let qnaActive = false;
	let interviewPath: string | undefined;

	function syncClarifyTools(): void {
		const active = new Set(pi.getActiveTools());
		if (qnaActive || interviewPath) active.add(TOOL_CLARIFY);
		else active.delete(TOOL_CLARIFY);
		if (interviewPath) active.add(TOOL_INTERVIEW_END);
		else active.delete(TOOL_INTERVIEW_END);
		pi.setActiveTools([...active]);
	}

	const interviewEndTool = defineTool<typeof interviewEndParamsSchema, { path: string }>({
		name: TOOL_INTERVIEW_END,
		label: "End Interview",
		description:
			"End the active interview after the user confirms the exit condition is satisfied. Update the decisions file before calling this tool.",
		promptSnippet: "End active interview only after user confirmation and final decisions file update.",
		promptGuidelines: [
			"Call interview_end only after the user confirms the interview goal and exit condition are satisfied.",
			"Before calling interview_end, update the interview decisions file with final coherent decisions, assumptions, and open questions.",
		],
		parameters: interviewEndParamsSchema,
		executionMode: "sequential",

		async execute() {
			if (!interviewPath) throw new Error("No active interview");
			const path = interviewPath;
			interviewPath = undefined;
			qnaActive = false;
			syncClarifyTools();
			return {
				content: [{ type: "text", text: `Interview ended. Decisions file: ${path}` }],
				details: { path },
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(TOOL_INTERVIEW_END)), 0, 0);
		},
	});

	pi.registerTool(clarifyTool);
	pi.registerTool(interviewEndTool);

	pi.on("session_start", () => {
		qnaActive = false;
		interviewPath = undefined;
		syncClarifyTools();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== TOOL_CLARIFY) return;
		qnaActive = false;
		syncClarifyTools();
	});
	pi.on("agent_end", () => {
		qnaActive = false;
		syncClarifyTools();
	});

	pi.registerCommand("qna", {
		description: "Ask the agent to re-ask its last question with structured choices",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}

			qnaActive = true;
			syncClarifyTools();
			pi.sendMessage({ customType: "tau.qna", content: QNA_PROMPT, display: false }, { triggerTurn: true });
		},
	});

	pi.registerCommand("interview", {
		description: "Start a structured interview and create a decisions file",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}

			const topic = args.trim();
			const path = await createInterviewFile(ctx.cwd, topic);
			interviewPath = path;
			qnaActive = false;
			syncClarifyTools();
			ctx.ui.notify(`Interview decisions: ${path}`, "info");
			pi.sendMessage(
				{ customType: "tau.interview", content: buildInterviewPrompt(path, topic), display: false },
				{ triggerTurn: true },
			);
		},
	});
}

function formatResult(result: ClarifyResult, formatLabel: (text: string) => string = (text) => text): string {
	return `\n${Object.values(result.answers)
		.map((answer, index) => formatAnswer(answer, index, formatLabel))
		.join("\n\n")}`;
}

function formatAnswer(
	answer: ClarifyResult["answers"][string],
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

function formatRecommendation(
	answer: ClarifyResult["answers"][string],
	formatLabel: (text: string) => string,
): string[] {
	if (!answer.recommendation) return [];
	const recommendation = answer.recommendation.labels;
	return [
		...(recommendation.length === 1
			? [`   ${formatLabel("Recommendation:")} ${recommendation[0]}`]
			: [`   ${formatLabel("Recommendation:")}`, ...recommendation.map((label) => `   - ${label}`)]),
		`   ${formatLabel("Reason:")} ${answer.recommendation.reason}`,
	];
}

function formatSingleAnswer(answer: ClarifyResult["answers"][string], formatLabel: (text: string) => string): string {
	const value = answer.kind === "input" ? answer.input : answer.labels[0];
	const answerLine = `   ${formatLabel("Answer:")} ${value || "_Skipped_"}`;
	return [answerLine, ...formatNotes(answer, "   ", answer.values[0])].join("\n");
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
	return notes.flatMap((note) => note.split("\n").map((line) => `${indent}└─ ${line}`));
}

async function createInterviewFile(cwd: string, topic: string): Promise<string> {
	const dir = join(".working", "interviews", `${timestamp()}-${slugify(topic || "interview")}`);
	await mkdir(join(cwd, dir), { recursive: true });
	const path = join(dir, "decisions.md");
	await writeFile(join(cwd, path), interviewTemplate(topic), "utf8");
	return path;
}

function interviewTemplate(topic: string): string {
	return `# ${topic || "Interview"}

## Goal

_To confirm._

## Exit Condition

_To confirm._

## Assumptions

- None yet.

## Decisions

- None yet.

## Open Questions

- Confirm interview goal and exit condition.
`;
}

function buildInterviewPrompt(path: string, topic: string): string {
	return `Run a structured interview.${topic ? ` Topic: ${topic}.` : ""}

Decisions file: ${path}

Rules:
- Treat the decisions file as source of truth for this interview.
- First confirm the shared goal and exit condition with the user.
- Always use clarify for interview questions, including freeform and yes/no.
- Default to one question at a time.
- Batch 2-3 questions only when answers are independent and one answer would not change how you ask the others.
- If unsure whether questions are independent, ask one.
- If a question can be answered by inspecting repo files, inspect instead of asking.
- After each user answer, update the decisions file before asking the next question.
- Prefer focused edits to the relevant section.
- Do not rewrite the whole decisions file unless coherence requires it: goal shift, contradiction, duplicate cleanup, stale assumptions, or major reorganization.
- Keep the file coherent over time: remove stale assumptions, duplicates, and contradictions when you touch related sections.
- If the user contradicts the file and the correct update is unclear, ask a clarify question before editing.
- When the exit condition appears satisfied, ask the user to confirm completion with clarify.
- After confirmation, update the final decisions file, then call interview_end.
- Do not call interview_end before user confirmation.`;
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "interview"
	);
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

// ponytail: validates/result-builds without TUI harness; real UI needs Pi runtime.
function demo(): void {
	const questions = normalizeParams({
		questions: [
			{ id: "ship", prompt: "Ship?", kind: "confirm", recommendation: { values: ["yes"], reason: "Ready." } },
			{
				id: "goal",
				prompt: "Goal?",
				kind: "input",
				recommendation: { values: ["Validate clarify input recommendations."], reason: "Covers freeform." },
			},
		],
	});
	const state = buildResult(createState(undefined, questions));
	if (state.answers.ship?.kind !== "confirm") throw new Error("clarify demo failed");
	if (state.answers.goal?.recommendation?.labels[0] !== "Validate clarify input recommendations.") {
		throw new Error("clarify input recommendation failed");
	}
	if (!formatResult(state).startsWith("\n1. Ship?")) throw new Error("clarify format failed");
}

if (process.argv[1]?.endsWith("src/extensions/clarify/index.ts")) demo();
