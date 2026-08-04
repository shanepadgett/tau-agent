export const DEFAULT_CHECKPOINT_TOKEN_LIMIT = 150_000;

export type CheckpointBudgetLevel = 0 | 50 | 75 | 100;
export type CheckpointBudgetNoticeLevel = Exclude<CheckpointBudgetLevel, 0>;

export interface CheckpointBudget {
	configure(limit: number): void;
	beginTurn(tokens: number | null): CheckpointBudgetNoticeLevel | undefined;
	finishTurn(tokens: number | null): CheckpointBudgetNoticeLevel | undefined;
	shouldBlockTool(toolName: string, checkpointToolName: string): boolean;
	reset(): void;
}

export function createCheckpointBudget(initialLimit = DEFAULT_CHECKPOINT_TOKEN_LIMIT): CheckpointBudget {
	let limit = validateLimit(initialLimit);
	let highestNoticed: CheckpointBudgetLevel = 0;
	let forced = false;

	return {
		configure(nextLimit: number): void {
			limit = validateLimit(nextLimit);
			highestNoticed = 0;
			forced = false;
		},

		beginTurn(tokens: number | null): CheckpointBudgetNoticeLevel | undefined {
			return observe(tokens);
		},

		finishTurn(tokens: number | null): CheckpointBudgetNoticeLevel | undefined {
			return observe(tokens);
		},

		shouldBlockTool(toolName: string, checkpointToolName: string): boolean {
			return forced && toolName !== checkpointToolName;
		},

		reset(): void {
			highestNoticed = 0;
			forced = false;
		},
	};

	function observe(tokens: number | null): CheckpointBudgetNoticeLevel | undefined {
		if (tokens === null) return undefined;
		const level = levelFor(tokens, limit);
		if (level === 100) forced = true;
		if (level <= highestNoticed) return undefined;
		highestNoticed = level;
		return level === 0 ? undefined : level;
	}
}

function levelFor(tokens: number, limit: number): CheckpointBudgetLevel {
	if (tokens >= limit) return 100;
	if (tokens >= limit * 0.75) return 75;
	if (tokens >= limit * 0.5) return 50;
	return 0;
}

function validateLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new Error("Checkpoint token limit must be a positive safe integer");
	}
	return limit;
}
