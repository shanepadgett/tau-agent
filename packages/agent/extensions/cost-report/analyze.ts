import { basename } from "node:path";
import { type SessionEntry, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { eachLocalDay, isWeekend, localDateKey, shortDateLabel } from "./range.ts";
import type {
	CostReport,
	CostTotals,
	DayCost,
	ModelCost,
	ProjectCost,
	ReportRange,
	ReportScope,
	SessionCost,
	SessionModelCost,
	SubagentCost,
} from "./types.ts";

export interface BuildCostReportOptions {
	cwd: string;
	range: ReportRange;
	scope: ReportScope;
	signal?: AbortSignal;
	onProgress?: (status: string) => void;
}

interface ModelBucket {
	key: string;
	provider: string;
	model: string;
	cost: number;
	tokens: number;
	sessions: Set<string>;
}

interface SubagentBucket {
	agent: string;
	cost: number;
	calls: number;
}

interface ProjectBucket {
	key: string;
	label: string;
	cost: number;
	tokens: number;
	sessions: Set<string>;
}

interface SessionModelBucket {
	key: string;
	label: string;
	cost: number;
}

interface AnalyzedSession {
	session: SessionCost;
	directCost: number;
	subagentCost: number;
	dayCosts: Map<string, number>;
	models: ModelBucket[];
	subagents: SubagentBucket[];
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeUsage(value: unknown): CostTotals {
	const record = asRecord(value);
	const cost = asRecord(record?.cost);
	const input = numberOrZero(record?.input);
	const output = numberOrZero(record?.output);
	const cacheRead = numberOrZero(record?.cacheRead);
	const cacheWrite = numberOrZero(record?.cacheWrite);
	const totalTokens = numberOrZero(record?.totalTokens) || input + output + cacheRead + cacheWrite;
	const costTotal =
		numberOrZero(cost?.total) ||
		numberOrZero(cost?.input) +
			numberOrZero(cost?.output) +
			numberOrZero(cost?.cacheRead) +
			numberOrZero(cost?.cacheWrite);
	return { input, output, cacheRead, cacheWrite, totalTokens, cost: costTotal };
}

function timestampMs(messageTimestamp: unknown, entryTimestamp: unknown): number | undefined {
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
	if (typeof entryTimestamp === "string") {
		const parsed = Date.parse(entryTimestamp);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function inRange(ms: number, range: ReportRange): boolean {
	return ms >= range.startMs && ms <= range.endMs;
}

function projectFromCwd(cwd: string): { key: string; label: string } {
	const trimmed = cwd.trim();
	if (!trimmed) return { key: "unknown", label: "unknown" };
	const label = basename(trimmed) || trimmed;
	return { key: trimmed, label };
}

function sessionDisplayName(entries: SessionEntry[], info: SessionInfo): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "session_info") continue;
		const name = entry.name?.trim();
		if (name) return name;
	}
	const first = info.firstMessage?.trim();
	if (first) return first.length > 80 ? `${first.slice(0, 77)}…` : first;
	return info.id;
}

function shortModelLabel(provider: string, model: string): string {
	if (model) return model;
	if (provider) return provider;
	return "unknown";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("cancelled");
}

export async function buildCostReport(options: BuildCostReportOptions): Promise<CostReport | undefined> {
	const { cwd, range, scope, signal, onProgress } = options;
	onProgress?.("Scanning sessions…");
	throwIfAborted(signal);

	const infos =
		scope === "project"
			? await SessionManager.list(cwd, undefined, (loaded, total) => {
					onProgress?.(`Scanning sessions… ${loaded}/${total}`);
				})
			: await SessionManager.listAll((loaded, total) => {
					onProgress?.(`Scanning sessions… ${loaded}/${total}`);
				});

	throwIfAborted(signal);
	onProgress?.(`Reading ${infos.length} sessions…`);

	const analyzed: AnalyzedSession[] = [];
	let index = 0;
	for (const info of infos) {
		index += 1;
		if (index === 1 || index % 10 === 0 || index === infos.length) {
			onProgress?.(`Reading sessions… ${index}/${infos.length}`);
		}
		throwIfAborted(signal);
		try {
			const result = analyzeSession(info, range);
			if (result) analyzed.push(result);
		} catch {
			// Skip unreadable sessions.
		}
	}

	throwIfAborted(signal);
	if (analyzed.length === 0) return undefined;

	onProgress?.("Building report…");

	const dayMap = new Map<string, number>();
	const modelMap = new Map<string, ModelBucket>();
	const subagentMap = new Map<string, SubagentBucket>();
	const projectMap = new Map<string, ProjectBucket>();
	let directCost = 0;
	let subagentCost = 0;
	let totalTokens = 0;

	for (const item of analyzed) {
		directCost += item.directCost;
		subagentCost += item.subagentCost;
		totalTokens += item.session.tokens;

		for (const [key, cost] of item.dayCosts) {
			dayMap.set(key, (dayMap.get(key) ?? 0) + cost);
		}

		for (const model of item.models) {
			const existing = modelMap.get(model.key);
			if (existing) {
				existing.cost += model.cost;
				existing.tokens += model.tokens;
				for (const sessionId of model.sessions) existing.sessions.add(sessionId);
			} else {
				modelMap.set(model.key, {
					...model,
					sessions: new Set(model.sessions),
				});
			}
		}

		for (const agent of item.subagents) {
			const existing = subagentMap.get(agent.agent);
			if (existing) {
				existing.cost += agent.cost;
				existing.calls += agent.calls;
			} else {
				subagentMap.set(agent.agent, { ...agent });
			}
		}

		const project = projectMap.get(item.session.projectKey);
		if (project) {
			project.cost += item.session.cost;
			project.tokens += item.session.tokens;
			project.sessions.add(item.session.id);
		} else {
			projectMap.set(item.session.projectKey, {
				key: item.session.projectKey,
				label: item.session.projectLabel,
				cost: item.session.cost,
				tokens: item.session.tokens,
				sessions: new Set([item.session.id]),
			});
		}
	}

	const days = buildDays(range, dayMap);
	const models: ModelCost[] = [...modelMap.values()]
		.map((bucket) => ({
			key: bucket.key,
			provider: bucket.provider,
			model: bucket.model,
			cost: bucket.cost,
			tokens: bucket.tokens,
			sessions: bucket.sessions.size,
		}))
		.sort((a, b) => b.cost - a.cost);

	const subagents: SubagentCost[] = [...subagentMap.values()].sort((a, b) => b.cost - a.cost);

	const projects: ProjectCost[] = [...projectMap.values()]
		.map((bucket) => ({
			key: bucket.key,
			label: bucket.label,
			cost: bucket.cost,
			sessions: bucket.sessions.size,
			tokens: bucket.tokens,
		}))
		.sort((a, b) => b.cost - a.cost);

	const sessions = analyzed.map((item) => item.session).sort((a, b) => b.cost - a.cost);

	return {
		generatedAtMs: Date.now(),
		cwd,
		scope,
		range,
		directCost,
		subagentCost,
		totalCost: directCost + subagentCost,
		totalTokens,
		sessionCount: sessions.length,
		projectCount: projects.length,
		days,
		models,
		subagents,
		projects,
		sessions,
	};
}

function buildDays(range: ReportRange, dayMap: Map<string, number>): DayCost[] {
	const days: DayCost[] = [];
	for (const dayStart of eachLocalDay(range.startMs, range.endMs)) {
		const dateKey = localDateKey(dayStart);
		days.push({
			dateKey,
			label: shortDateLabel(dayStart),
			timestampMs: dayStart,
			cost: dayMap.get(dateKey) ?? 0,
			weekend: isWeekend(dayStart),
		});
	}
	return days;
}

function analyzeSession(info: SessionInfo, range: ReportRange): AnalyzedSession | undefined {
	const manager = SessionManager.open(info.path);
	const entries = manager.getEntries();
	const header = manager.getHeader();
	const cwd = header?.cwd || info.cwd || "";
	const project = projectFromCwd(cwd);
	const sessionId = header?.id || info.id;
	const name = sessionDisplayName(entries, info);

	const dayCosts = new Map<string, number>();
	const modelBuckets = new Map<string, SessionModelBucket & { tokens: number; provider: string; model: string }>();
	const subagentBuckets = new Map<string, SubagentBucket>();
	let directCost = 0;
	let subagentCost = 0;
	let tokens = 0;
	let startedAtMs = Number.POSITIVE_INFINITY;

	for (const entry of entries) {
		if (entry.type !== "message") {
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
				const ts = timestampMs(undefined, entry.timestamp);
				if (ts === undefined || !inRange(ts, range)) continue;
				const usage = normalizeUsage(entry.usage);
				if (usage.cost <= 0 && usage.totalTokens <= 0) continue;
				directCost += usage.cost;
				tokens += usage.totalTokens;
				dayCosts.set(localDateKey(ts), (dayCosts.get(localDateKey(ts)) ?? 0) + usage.cost);
				if (ts < startedAtMs) startedAtMs = ts;
			}
			continue;
		}

		const message = entry.message as {
			role?: string;
			timestamp?: number;
			provider?: string;
			model?: string;
			usage?: unknown;
			toolName?: string;
			details?: unknown;
		};

		const ts = timestampMs(message.timestamp, entry.timestamp);
		if (ts === undefined || !inRange(ts, range)) continue;

		if (message.role === "assistant" && message.usage) {
			const usage = normalizeUsage(message.usage);
			if (usage.cost <= 0 && usage.totalTokens <= 0) continue;
			directCost += usage.cost;
			tokens += usage.totalTokens;
			dayCosts.set(localDateKey(ts), (dayCosts.get(localDateKey(ts)) ?? 0) + usage.cost);
			if (ts < startedAtMs) startedAtMs = ts;

			const provider = typeof message.provider === "string" ? message.provider : "unknown";
			const model = typeof message.model === "string" ? message.model : "unknown";
			const key = `${provider}/${model}`;
			const existing = modelBuckets.get(key);
			if (existing) {
				existing.cost += usage.cost;
				existing.tokens += usage.totalTokens;
			} else {
				modelBuckets.set(key, {
					key,
					label: shortModelLabel(provider, model),
					provider,
					model,
					cost: usage.cost,
					tokens: usage.totalTokens,
				});
			}
			continue;
		}

		if (message.role === "toolResult" && message.usage) {
			const usage = normalizeUsage(message.usage);
			if (usage.cost <= 0 && usage.totalTokens <= 0) continue;
			dayCosts.set(localDateKey(ts), (dayCosts.get(localDateKey(ts)) ?? 0) + usage.cost);
			if (ts < startedAtMs) startedAtMs = ts;
			tokens += usage.totalTokens;

			if (message.toolName === "subagent") {
				subagentCost += usage.cost;
				const details = asRecord(message.details);
				const agent =
					(typeof details?.agent === "string" && details.agent) ||
					(typeof details?.displayName === "string" && details.displayName) ||
					"subagent";
				const existing = subagentBuckets.get(agent);
				if (existing) {
					existing.cost += usage.cost;
					existing.calls += 1;
				} else {
					subagentBuckets.set(agent, { agent, cost: usage.cost, calls: 1 });
				}
			} else {
				directCost += usage.cost;
			}
		}
	}

	const sessionCost = directCost + subagentCost;
	if (sessionCost <= 0 && tokens <= 0) return undefined;

	const models: ModelBucket[] = [...modelBuckets.values()].map((bucket) => ({
		key: bucket.key,
		provider: bucket.provider,
		model: bucket.model,
		cost: bucket.cost,
		tokens: bucket.tokens,
		sessions: new Set([sessionId]),
	}));

	const sessionModels: SessionModelCost[] = [...modelBuckets.values()]
		.map((bucket) => ({
			key: bucket.key,
			label: bucket.label,
			cost: bucket.cost,
		}))
		.sort((a, b) => b.cost - a.cost);

	return {
		session: {
			id: sessionId,
			path: info.path,
			name,
			projectKey: project.key,
			projectLabel: project.label,
			startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : range.startMs,
			cost: sessionCost,
			tokens,
			models: sessionModels,
		},
		directCost,
		subagentCost,
		dayCosts,
		models,
		subagents: [...subagentBuckets.values()],
	};
}
