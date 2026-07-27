import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Marker } from "@shanepadgett/tau-tui";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.ts";
import type { WorkingMemoryInput } from "./checkpoint.ts";
import { parseWorkingMemoryDetails } from "./state.ts";

const MAX_ITEMS = 20;
const MAX_LINE = 240;
const MAX_TEXT = 4_000;

export type WorkingMemoryNudgeDetails =
	| {
			v: 1;
			kind: "automatic";
			tokens: number;
			boundaryTokens: number;
			reminder: number;
			tier: number;
			tierCount: number;
			anchorToolCallId: string | null;
	  }
	| {
			v: 1;
			kind: "manual";
			tokens: null;
			boundaryTokens: null;
			reminder: null;
			tier: null;
			tierCount: null;
			anchorToolCallId: string | null;
	  };

export function parseWorkingMemoryNudge(value: unknown): WorkingMemoryNudgeDetails | undefined {
	if (!isRecord(value) || value.v !== 1 || (value.kind !== "automatic" && value.kind !== "manual")) return undefined;
	if (value.anchorToolCallId !== null && !nonempty(value.anchorToolCallId)) return undefined;
	if (value.kind === "manual") {
		if (
			value.tokens !== null ||
			value.boundaryTokens !== null ||
			value.reminder !== null ||
			value.tier !== null ||
			value.tierCount !== null
		) {
			return undefined;
		}
		return {
			v: 1,
			kind: "manual",
			tokens: null,
			boundaryTokens: null,
			reminder: null,
			tier: null,
			tierCount: null,
			anchorToolCallId: value.anchorToolCallId,
		};
	}
	if (
		!count(value.tokens, 0) ||
		!count(value.boundaryTokens, 1) ||
		!count(value.reminder, 1) ||
		!count(value.tier, 1, 5) ||
		!count(value.tierCount, 1, 5) ||
		value.boundaryTokens > value.tokens ||
		value.tier > value.tierCount ||
		value.tier !== Math.min(value.reminder, value.tierCount)
	) {
		return undefined;
	}
	return {
		v: 1,
		kind: "automatic",
		tokens: value.tokens,
		boundaryTokens: value.boundaryTokens,
		reminder: value.reminder,
		tier: value.tier,
		tierCount: value.tierCount,
		anchorToolCallId: value.anchorToolCallId,
	};
}

export function renderWorkingMemoryNudge(details: unknown, theme: Theme): Marker | undefined {
	const parsed = parseWorkingMemoryNudge(details);
	if (!parsed) return undefined;
	return new Marker({
		theme,
		state: "muted",
		label: "Memory:",
		parts:
			parsed.kind === "manual" ? ["Reassessment requested."] : [formatTokens(parsed.boundaryTokens), "Reassess."],
	});
}

export function renderWorkingMemoryCall(
	args: WorkingMemoryInput,
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
	const kept = Array.isArray(args.keep) ? args.keep.length : 0;
	const outlined = Array.isArray(args.outlineFiles) ? args.outlineFiles.length : 0;
	const deferred = Array.isArray(args.deferFiles) ? args.deferFiles.length : 0;
	component.setText(
		`${formatToolRowTitle(context.rowState, context.rowId, "working_memory", theme)} ${theme.fg("muted", `${kept} kept · ${outlined} outline · ${deferred} deferred`)}`,
	);
	return component;
}

export function renderWorkingMemoryResult(
	result: AgentToolResult<unknown>,
	expanded: boolean,
	theme: Theme,
	lastComponent: unknown,
): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	const details = parseWorkingMemoryDetails(result.details);
	if (!details) {
		component.setText(
			theme.fg("warning", bounded(firstText(result) || "working_memory returned invalid details", 1_000)),
		);
		return component;
	}
	let text = theme.fg(
		details.warnings.length === 0 ? "success" : "warning",
		`Checkpoint · kept ${details.retainedRefs.length} · outlined ${details.outlinedFiles.length} · deferred ${details.deferredFiles.length} · removed ${details.removedUnits}${details.warnings.length === 0 ? "" : ` · warnings ${details.warnings.length}`}`,
	);
	if (expanded) {
		const lines = [
			bounded(firstText(result), 1_500),
			...details.retainedLabels.map((item) => `${item.ref} ${item.label}: ${item.preview}`),
			...details.outlinedFiles.map((file) => `outlined: ${file.path}`),
			...details.deferredFiles.map((file) => `deferred: ${file.path} — ${file.reason}; when ${file.relevantWhen}`),
			...details.warnings.map((warning) => `warning: ${warning}`),
		].filter(Boolean);
		let remaining = MAX_TEXT - visibleWidth(text);
		for (const line of lines.slice(0, MAX_ITEMS)) {
			if (remaining <= 1) break;
			const styled = theme.fg("dim", bounded(line, MAX_LINE));
			text += `\n${truncateToWidth(styled, remaining - 1, "…")}`;
			remaining -= 1 + Math.min(visibleWidth(styled), remaining - 1);
		}
		if (lines.length > MAX_ITEMS && remaining > 10)
			text += `\n${theme.fg("dim", `… ${lines.length - MAX_ITEMS} more`)}`;
	}
	component.setText(text);
	return component;
}

function firstText(result: AgentToolResult<unknown>): string {
	for (const part of result.content) if (part.type === "text") return part.text;
	return "";
}

function bounded(text: string, maximum: number): string {
	return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function formatTokens(tokens: number): string {
	return tokens < 1_000 ? `${tokens}` : `${Math.round(tokens / 1_000)}k`;
}

function count(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
