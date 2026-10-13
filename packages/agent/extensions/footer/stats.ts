import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { INFO_SEPARATOR } from "@shanepadgett/tau-tui";
import type { TauAgentEvents } from "../../shared/events.ts";
import { normalizeUsage, type UsageSummary } from "../../shared/usage.ts";

export interface StatsState {
	ctx: ExtensionContext;
	thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	classifier: string | null;
	dailyCost: number | undefined;
}

/**
 * Text for the footer's first row. `left` is model plus classifier and `modelOnly` drops the
 * classifier. `right` lists cost forms from most to least detailed; the footer uses the first that fits.
 */
export function statsParts(
	theme: Theme,
	state: StatsState,
): { left: string; modelOnly: string; right: [string, ...string[]] } {
	const { ctx } = state;
	const usage = sessionCost(ctx);
	const session = formatCost(usage.cost);
	const daily = state.dailyCost === undefined ? "$?" : formatCost(state.dailyCost);
	const cacheHit = usage.latestCacheHitRate === undefined ? undefined : `CH${usage.latestCacheHitRate.toFixed(1)}%`;
	const dot = theme.fg("dim", INFO_SEPARATOR);
	const model = ctx.model ? (ctx.model.name || ctx.model.id).replace(/^Claude /, "") : "no-model";
	const thinking = state.thinking;
	const modelText = `${model} ${theme.fg("dim", "(")}${theme.getThinkingBorderColor(thinking)(thinking)}${theme.fg("dim", ")")}`;
	const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join(dot);
	const dim = (text: string | undefined) => (text ? theme.fg("dim", text) : undefined);
	return {
		left: join([modelText, state.classifier ? theme.fg("dim", state.classifier) : undefined]),
		modelOnly: modelText,
		right: [
			join([dim(cacheHit), dim(`${session} session`), dim(`${daily} today`)]),
			join([dim(cacheHit), dim(session), dim(daily)]),
			join([dim(cacheHit), dim(session)]),
			join([dim(session)]),
		],
	};
}

function sessionCost(ctx: Pick<ExtensionContext, "sessionManager">): UsageSummary {
	let usage = zeroUsage();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === "tau.decisions.usage") {
			const cost = (entry.data as { cost?: unknown } | undefined)?.cost;
			usage.cost += typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			usage = addUsage(usage, normalizeUsage(entry.message.usage), true);
			continue;
		}
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			usage = addUsage(usage, normalizeUsage(entry.message.usage), false);
			continue;
		}
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			usage = addUsage(usage, normalizeUsage(entry.usage), false);
		}
	}
	return usage;
}

const CELLS = 16;

export function contextBar(
	theme: Theme,
	ctx: ExtensionContext,
	level: TauAgentEvents["tau:compaction.level"] | null,
): string {
	const cells = CELLS;
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percentValue = typeof usage?.percent === "number" ? usage.percent : undefined;
	const thresholds = level?.thresholds;
	const currentTokens = usage?.tokens ?? level?.tokens ?? null;
	const tail = cells / 4;
	const latest = [...ctx.sessionManager.buildSessionProjection().messages]
		.reverse()
		.find((message) => message.role === "assistant");
	const cachedTokens =
		latest?.role === "assistant" && currentTokens !== null
			? Math.max(0, Math.min(currentTokens, latest.usage.cacheRead))
			: 0;
	if (thresholds && contextWindow > thresholds.forced) {
		// Linear track from 0 to the forced threshold, then a log-scaled tail from forced to the context window.
		const tokens = currentTokens ?? 0;
		const usedCells = Math.min(cells, Math.ceil((tokens / thresholds.forced) * cells));
		const cachedCells = Math.min(usedCells, Math.floor((cachedTokens / thresholds.forced) * cells));
		const noticeCell = Math.max(1, Math.min(cells - 2, Math.round((thresholds.notice / thresholds.forced) * cells)));
		const warningCell = Math.max(
			noticeCell + 1,
			Math.min(cells - 1, Math.round((thresholds.warning / thresholds.forced) * cells)),
		);
		const wallColor: ThemeColor = tokens >= thresholds.forced ? "error" : "dim";
		let bar = theme.fg("dim", "|");
		for (let index = 0; index < cells; index++) {
			if (index === noticeCell) bar += theme.fg(tokens >= thresholds.notice ? "warning" : "dim", "?");
			if (index === warningCell) bar += theme.fg(tokens >= thresholds.warning ? "error" : "dim", "!");
			const cellColor: ThemeColor = index >= warningCell ? "error" : index >= noticeCell ? "warning" : "success";
			bar +=
				currentTokens === null
					? theme.fg("dim", "?")
					: index < cachedCells
						? theme.fg(cellColor, "•")
						: index < usedCells
							? theme.fg(cellColor, "·")
							: theme.fg("dim", "-");
		}
		bar += theme.fg(wallColor, "|");
		for (let index = 0; index < tail; index++) {
			const start = thresholds.forced * (contextWindow / thresholds.forced) ** (index / tail);
			bar += tokens > start ? theme.fg("error", "▓") : theme.fg("dim", "░");
		}
		return `${bar}${theme.fg("dim", "|")}`;
	}
	const total = cells + tail;
	const usedCells =
		contextWindow > 0 && currentTokens !== null
			? Math.min(total, Math.ceil((currentTokens / contextWindow) * total))
			: 0;
	const cachedCells = contextWindow > 0 ? Math.min(usedCells, Math.floor((cachedTokens / contextWindow) * total)) : 0;
	const color: ThemeColor =
		level?.level === "forced" ? "error" : level?.level === "warning" ? "warning" : contextPercentColor(percentValue);
	const bar = Array.from({ length: total }, (_value, index) => {
		const cell =
			currentTokens === null || contextWindow <= 0 ? "?" : index < cachedCells ? "•" : index < usedCells ? "·" : "-";
		return theme.fg(cell === "•" || cell === "·" ? color : "dim", cell);
	}).join("");
	return `${theme.fg("dim", "[")}${bar}${theme.fg("dim", "]")}`;
}

function contextPercentColor(percent: number | undefined): ThemeColor {
	if (percent === undefined) return "dim";
	if (percent > 80) return "error";
	if (percent > 50) return "warning";
	return "dim";
}

function addUsage(left: UsageSummary, right: UsageSummary, updateCacheHitRate: boolean): UsageSummary {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		latestCacheHitRate: updateCacheHitRate
			? (right.latestCacheHitRate ?? left.latestCacheHitRate)
			: left.latestCacheHitRate,
		cost: left.cost + right.cost,
	};
}

function zeroUsage(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, latestCacheHitRate: undefined, cost: 0 };
}

function formatCost(value: number): string {
	return `$${value.toFixed(2)}`;
}
