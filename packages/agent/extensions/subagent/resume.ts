import type { AgentDefinition } from "./agents.ts";

const RESUME_OPTIONAL_HISTORY_TOKENS = 20_000;

export type RetainedTurnOutcome = "completed" | "failed" | "aborted";

export interface RetainedTurnRecord {
	task: string;
	outcome: RetainedTurnOutcome;
	terminalText: string;
	files: readonly string[];
}

export interface SubagentResumeState {
	records: readonly RetainedTurnRecord[];
	relevantPaths: readonly string[];
}

export function emptySubagentResumeState(): SubagentResumeState {
	return { records: [], relevantPaths: [] };
}

export function retainSubagentTurn(state: SubagentResumeState, record: RetainedTurnRecord): SubagentResumeState {
	const paths = new Set(state.relevantPaths);
	for (const path of record.files) paths.add(path);
	return {
		records: [...state.records, { ...record, files: [...record.files] }],
		relevantPaths: [...paths],
	};
}

export function selectRetainedTurns(
	state: SubagentResumeState,
	optionalTokenBudget = RESUME_OPTIONAL_HISTORY_TOKENS,
): { records: readonly RetainedTurnRecord[]; omitted: number } {
	const initial = state.records[0];
	if (!initial) return { records: [], omitted: 0 };
	let used = 0;
	const selectedIndexes = new Set<number>();
	for (let index = state.records.length - 1; index >= 1; index -= 1) {
		const record = state.records[index];
		if (!record) continue;
		const tokens = Math.ceil(JSON.stringify(record).length / 4);
		if (used + tokens > optionalTokenBudget) continue;
		used += tokens;
		selectedIndexes.add(index);
	}
	return {
		records: [initial, ...state.records.slice(1).filter((_record, index) => selectedIndexes.has(index + 1))],
		omitted: state.records.length - 1 - selectedIndexes.size,
	};
}

export function buildColdResumePrompt(options: {
	definition: AgentDefinition;
	state: SubagentResumeState;
	followUp: string;
	hasAutoreadFiles: boolean;
}): string {
	const selected = selectRetainedTurns(options.state);
	const data = JSON.stringify({
		version: 1,
		retainedTurns: selected.records,
		omittedRetainedTurns: selected.omitted,
		relevantPaths: options.state.relevantPaths,
		parentFollowUp: options.followUp,
	});
	return `You are an isolated delegated child agent resuming prior delegated work. Stay within the delegated task and return only the requested result.${options.hasAutoreadFiles ? " Parent-supplied autoread files are included as line-numbered context for this turn." : ""}

## Agent instructions
${options.definition.prompt}

The JSON object between the fixed markers is prior work data. Its retained terminal text is exact. Earlier file contents, tool calls, tool results, intermediate responses, and thinking are absent. Relevant paths are a manifest only; read current source before relying on it.

<tau-subagent-resume-json>
${data}
</tau-subagent-resume-json>`;
}
