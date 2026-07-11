import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Marker } from "../../shared/tui/marker.ts";

const ENTRY_TYPE = "tau.run-summary";

interface RunSummary {
	wallMs: number;
	runCost: number;
	subagentCost: number;
	totalCost: number;
}

export default function runSummaryExtension(pi: ExtensionAPI): void {
	let startedAt: number | undefined;

	pi.registerEntryRenderer<RunSummary>(ENTRY_TYPE, (entry, _options, theme) => {
		const summary = readRunSummary(entry.data);
		if (!summary) return undefined;
		return new Marker({
			theme,
			state: "muted",
			label: "Run complete:",
			parts: [
				`Wall ${formatDuration(summary.wallMs)}`,
				`Run ${formatCost(summary.runCost)}`,
				`Subagents ${formatCost(summary.subagentCost)}`,
				`Total ${formatCost(summary.totalCost)}`,
			],
		});
	});

	pi.on("session_start", () => {
		startedAt = undefined;
	});

	pi.on("agent_start", () => {
		startedAt = performance.now();
	});

	pi.on("agent_end", (event) => {
		if (startedAt === undefined) return;
		const wallMs = Math.max(0, performance.now() - startedAt);
		startedAt = undefined;
		let runCost = 0;
		let subagentCost = 0;
		for (const message of event.messages) {
			if (message.role === "assistant") {
				runCost += finiteNonNegative((message as AssistantMessage).usage.cost.total);
				continue;
			}
			if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
			subagentCost += readSubagentCost(message.details);
		}
		pi.appendEntry<RunSummary>(ENTRY_TYPE, {
			wallMs,
			runCost,
			subagentCost,
			totalCost: runCost + subagentCost,
		});
	});
}

function readSubagentCost(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	const usage = (value as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object") return 0;
	return finiteNonNegative((usage as Record<string, unknown>).cost);
}

function readRunSummary(value: unknown): RunSummary | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (![record.wallMs, record.runCost, record.subagentCost, record.totalCost].every(isFiniteNonNegative))
		return undefined;
	return {
		wallMs: record.wallMs as number,
		runCost: record.runCost as number,
		subagentCost: record.subagentCost as number,
		totalCost: record.totalCost as number,
	};
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteNonNegative(value: unknown): number {
	return isFiniteNonNegative(value) ? value : 0;
}

function formatDuration(milliseconds: number): string {
	return milliseconds < 1_000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}
