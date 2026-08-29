export type ReportScope = "project" | "all";

export type LiveRangeKind = "past-7-days" | "current-week" | "current-month" | "year-to-date";

export type RangeKind = LiveRangeKind | "specific-month";

export interface ReportRange {
	kind: RangeKind;
	label: string;
	slug: string;
	startMs: number;
	endMs: number;
	/** Single full-width day row vs one row per month (YTD). */
	layout: "row" | "ytd";
	year?: number;
	month?: number; // 0-11
}

export interface CostTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface ModelCost {
	key: string;
	provider: string;
	model: string;
	cost: number;
	tokens: number;
	sessions: number;
}

export interface SubagentCost {
	agent: string;
	cost: number;
	calls: number;
}

export interface ProjectCost {
	key: string;
	label: string;
	cost: number;
	sessions: number;
	tokens: number;
}

export interface SessionModelCost {
	key: string;
	label: string;
	cost: number;
}

export interface SessionCost {
	id: string;
	path: string;
	name: string;
	projectKey: string;
	projectLabel: string;
	startedAtMs: number;
	cost: number;
	tokens: number;
	models: SessionModelCost[];
}

export interface DayCost {
	dateKey: string; // YYYY-MM-DD local
	label: string;
	timestampMs: number;
	cost: number;
	weekend: boolean;
}

export interface CostReport {
	generatedAtMs: number;
	cwd: string;
	scope: ReportScope;
	range: ReportRange;
	directCost: number;
	subagentCost: number;
	totalCost: number;
	totalTokens: number;
	sessionCount: number;
	projectCount: number;
	days: DayCost[];
	models: ModelCost[];
	subagents: SubagentCost[];
	projects: ProjectCost[];
	sessions: SessionCost[];
}
