import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Marker } from "@shanepadgett/tau-tui";
import { parseContextPruneDetailsV1 } from "../../shared/context-pruning-state.ts";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.ts";
import type { ContextPruneInput } from "./prune.ts";

const MAX_EXPANDED_ITEMS = 20;
const MAX_EXPANDED_LINE_CHARACTERS = 240;
const MAX_EXPANDED_TEXT_CHARACTERS = 3_000;
const MAX_WARNING_CHARACTERS = 1_000;

export interface ContextPruningNudgeDetailsV1 {
	v: 1;
	kind: "automatic" | "manual";
	percent: number | null;
	boundary: number | null;
	pressure: boolean;
	anchorToolCallId: string | null;
	growthBaselinePercent: number | null;
}

export function parseContextPruningNudgeDetailsV1(value: unknown): ContextPruningNudgeDetailsV1 | undefined {
	if (!isRecord(value)) return undefined;
	const keys = ["v", "kind", "percent", "boundary", "pressure", "anchorToolCallId", "growthBaselinePercent"];
	if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return undefined;
	if (value.v !== 1 || (value.kind !== "automatic" && value.kind !== "manual")) return undefined;
	if (typeof value.pressure !== "boolean") return undefined;
	if (
		value.anchorToolCallId !== null &&
		(typeof value.anchorToolCallId !== "string" || value.anchorToolCallId.length === 0)
	) {
		return undefined;
	}
	if (value.kind === "manual") {
		if (value.percent !== null || value.boundary !== null || value.growthBaselinePercent !== null || value.pressure)
			return undefined;
		return {
			v: 1,
			kind: "manual",
			percent: null,
			boundary: null,
			pressure: false,
			anchorToolCallId: value.anchorToolCallId,
			growthBaselinePercent: null,
		};
	}
	if (
		!isPercent(value.percent) ||
		!isBoundary(value.boundary) ||
		!isPercent(value.growthBaselinePercent) ||
		value.boundary > value.percent ||
		value.growthBaselinePercent > value.percent
	) {
		return undefined;
	}
	return {
		v: 1,
		kind: "automatic",
		percent: value.percent,
		boundary: value.boundary,
		pressure: value.pressure,
		anchorToolCallId: value.anchorToolCallId,
		growthBaselinePercent: value.growthBaselinePercent,
	};
}

export function renderContextPruningNudge(details: unknown, theme: Theme): Marker | undefined {
	const parsed = parseContextPruningNudgeDetailsV1(details);
	if (!parsed) return undefined;
	return new Marker({
		theme,
		state: "muted",
		label: "Context:",
		parts:
			parsed.kind === "manual"
				? ["Prune requested."]
				: [`${parsed.percent}%`, ...(parsed.pressure ? ["Prune suggested."] : [])],
	});
}

export function renderContextPruneCall(
	args: ContextPruneInput,
	theme: Theme,
	context: {
		rowState: ToolRowStateStore;
		rowId: string;
		invalidate: () => void;
		lastComponent: unknown;
	},
): Text {
	context.rowState.watch(context.rowId, context.invalidate);
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const count =
		(Array.isArray(args.keepFiles) ? args.keepFiles.length : 0) +
		(Array.isArray(args.keepToolCalls) ? args.keepToolCalls.length : 0) +
		(Array.isArray(args.deferFiles) ? args.deferFiles.length : 0);
	component.setText(
		`${formatToolRowTitle(context.rowState, context.rowId, "context_prune", theme)} ${theme.fg("muted", `${count} selection${count === 1 ? "" : "s"}`)}`,
	);
	return component;
}

export function renderContextPruneResult(
	result: AgentToolResult<unknown>,
	expanded: boolean,
	theme: Theme,
	lastComponent: unknown,
): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	const details = parseContextPruneDetailsV1(result.details);
	if (!details) {
		component.setText(
			theme.fg(
				"warning",
				boundedText(firstResultText(result) || "context_prune returned invalid details", MAX_WARNING_CHARACTERS),
			),
		);
		return component;
	}
	if (details.status === "skipped") {
		component.setText(
			theme.fg("warning", boundedText(firstResultText(result) || "Prune skipped", MAX_WARNING_CHARACTERS)),
		);
		return component;
	}

	const pruned = details.newlyPrunedToolCallIds.length + details.newlyPrunedAutoreadRowIds.length;
	const retained = details.retainedToolCallIds.length + details.retainedAutoreadRowIds.length;
	let text = theme.fg(
		"success",
		`Pruned ${pruned} · retained ${retained} · refreshed ${details.refreshedFiles.length} · deferred ${details.deferredFiles.length}`,
	);
	if (expanded) {
		const lines = [
			...details.newlyPrunedToolCallIds.map((id) => `pruned tool: ${id}`),
			...details.newlyPrunedAutoreadRowIds.map((id) => `pruned autoread: ${id}`),
			...details.retainedToolCallIds.map((id) => `retained tool: ${id}`),
			...details.retainedAutoreadRowIds.map((id) => `retained autoread: ${id}`),
			...details.refreshedFiles.map((file) => `refreshed: ${file.path} (${file.rowId})`),
			...details.deferredFiles.map((file) => `deferred: ${file.path} — ${file.reason}; when ${file.relevantWhen}`),
		];
		const shown = lines.slice(0, MAX_EXPANDED_ITEMS).map((line) => boundedText(line, MAX_EXPANDED_LINE_CHARACTERS));
		if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more`);
		let remainingWidth = Math.max(0, MAX_EXPANDED_TEXT_CHARACTERS - visibleWidth(text));
		for (const line of shown) {
			if (remainingWidth <= 1) break;
			const styled = theme.fg("dim", line);
			const availableWidth = remainingWidth - 1;
			text += `\n${truncateToWidth(styled, availableWidth, "…")}`;
			remainingWidth -= 1 + Math.min(visibleWidth(styled), availableWidth);
			if (visibleWidth(styled) > availableWidth) break;
		}
	}
	component.setText(text);
	return component;
}

function boundedText(text: string, maximumCharacters: number): string {
	if (text.length <= maximumCharacters) return text;
	return `${text.slice(0, Math.max(0, maximumCharacters - 1))}…`;
}

function firstResultText(result: AgentToolResult<unknown>): string {
	for (const part of result.content) if (part.type === "text") return part.text;
	return "";
}

function isPercent(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

function isBoundary(value: unknown): value is number {
	return isPercent(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
