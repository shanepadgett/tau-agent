import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Marker } from "@shanepadgett/tau-tui";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.ts";
import type { SessionMemoryInput } from "./state.ts";

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
	_args: SessionMemoryInput,
	theme: Theme,
	context: {
		visible: boolean;
		rowState: ToolRowStateStore;
		rowId: string;
		invalidate: () => void;
		lastComponent: unknown;
	},
): Text {
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	if (!context.visible) {
		component.setText("");
		return component;
	}
	context.rowState.watch(context.rowId, context.invalidate);
	component.setText(formatToolRowTitle(context.rowState, context.rowId, "session_memory", theme));
	return component;
}

export function renderSessionMemoryResult(
	result: AgentToolResult<unknown>,
	visible: boolean,
	theme: Theme,
	lastComponent: unknown,
): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	if (!visible) {
		component.setText("");
		return component;
	}
	component.setText(`\n${theme.fg("toolOutput", firstText(result))}`);
	return component;
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
