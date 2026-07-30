import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Marker } from "@shanepadgett/tau-tui";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.ts";
import { parseSessionMemoryDetails, type SessionMemoryDetailsV1, type SessionMemoryInput } from "./state.ts";

export interface SessionMemoryInstructionDetails {
	v: 1;
	kind: "reminder" | "warning" | "required" | "manual";
	boundaryTokens: number | null;
}

export function renderSessionMemoryInstruction(details: unknown, theme: Theme): Marker | undefined {
	if (!isInstruction(details)) return undefined;
	const label = details.kind === "required" ? "Checkpoint:" : "Memory:";
	const part =
		details.kind === "manual"
			? "Reassessment requested."
			: details.kind === "required"
				? "Required."
				: `${formatTokens(details.boundaryTokens ?? 0)} · ${details.kind === "warning" ? "Review soon." : "Review."}`;
	return new Marker({ theme, state: details.kind === "required" ? "warning" : "muted", label, parts: [part] });
}

export function renderSessionMemoryCall(
	args: SessionMemoryInput,
	theme: Theme,
	context: {
		rowState: ToolRowStateStore;
		rowId: string;
		invalidate: () => void;
		lastComponent: unknown;
		executionStarted: boolean;
	},
): Text {
	context.rowState.watch(context.rowId, context.invalidate);
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	if (context.executionStarted) {
		component.setText("");
		return component;
	}
	const summary =
		args.action === "checkpoint"
			? "checkpoint"
			: `${args.tasks.length} tasks · ${args.carry.length} carry · ${args.durable.length} durable · ${args.readFiles.length} read · ${args.outlineFiles.length} outline · ${args.deferFiles.length} deferred`;
	component.setText(
		`${formatToolRowTitle(context.rowState, context.rowId, "session_memory", theme)} ${theme.fg("muted", summary)}`,
	);
	return component;
}

export function renderSessionMemoryResult(
	result: AgentToolResult<unknown>,
	expanded: boolean,
	theme: Theme,
	lastComponent: unknown,
	toolCallId: string,
): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	const text = firstText(result);
	const details = parseSessionMemoryDetails(result.details, toolCallId, text);
	if (!details) {
		component.setText(theme.fg("warning", text || "session_memory returned invalid details"));
		return component;
	}
	component.setText(expanded ? text : collapsed(details, theme));
	return component;
}

function collapsed(details: SessionMemoryDetailsV1, theme: Theme): string {
	const state = details.state;
	const files = state.readFiles.length + state.outlineFiles.length + state.deferFiles.length;
	const label = details.kind === "checkpoint" ? `Checkpoint ${details.checkpoint}` : "Updated";
	return theme.fg(
		details.warnings.length > 0 ? "warning" : "success",
		`${label} · ${state.tasks.length} tasks · ${state.carry.length} carry · ${state.durable.length} durable · ${files} files${details.warnings.length > 0 ? ` · ${details.warnings.length} warnings` : ""}`,
	);
}

function firstText(result: AgentToolResult<unknown>): string {
	for (const item of result.content) if (item.type === "text") return item.text;
	return "";
}

function isInstruction(value: unknown): value is SessionMemoryInstructionDetails {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	return (
		item.v === 1 &&
		(item.kind === "reminder" || item.kind === "warning" || item.kind === "required" || item.kind === "manual") &&
		(item.boundaryTokens === null ||
			(Number.isSafeInteger(item.boundaryTokens) && (item.boundaryTokens as number) >= 0))
	);
}

function formatTokens(tokens: number): string {
	return tokens < 1_000 ? String(tokens) : `${Math.round(tokens / 1_000)}k`;
}
