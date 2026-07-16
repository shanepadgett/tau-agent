import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import type { SubagentDetails } from "./run.ts";

const cap = (text: string | undefined, length = 240) =>
	!text ? "" : text.length <= length ? text : `${text.slice(0, length - 1)}…`;
const component = (last: unknown) => (last as Text | undefined) ?? new Text("", 0, 0);
const title = (theme: Theme, rowState: ToolRowStateStore, rowId: string, invalidate: () => void) => {
	rowState.watch(rowId, invalidate);
	return formatToolRowTitle(rowState, rowId, "subagent", theme);
};

export function renderSubagentCall(
	args: { agent?: string; task?: string },
	theme: Theme,
	context: {
		executionStarted: boolean;
		isPartial: boolean;
		lastComponent?: unknown;
		rowState: ToolRowStateStore;
		rowId: string;
		invalidate: () => void;
	},
): Component {
	const text = component(context.lastComponent);
	if (context.executionStarted || !context.isPartial) {
		text.setText("");
		return text;
	}
	const prefix =
		`${title(theme, context.rowState, context.rowId, context.invalidate)}  ${theme.fg("accent", args.agent ?? "")}`.trimEnd();
	const task = args.task?.replace(/\s+/g, " ").trim();
	text.setText(task ? `${prefix}  ${theme.fg("muted", task)}` : prefix);
	return text;
}

export function renderSubagentResult(
	result: { details?: SubagentDetails },
	expanded: boolean,
	theme: Theme,
	context: { lastComponent?: unknown; rowState: ToolRowStateStore; rowId: string; invalidate: () => void },
): Component {
	const text = component(context.lastComponent);
	const details = result.details;
	if (!details) {
		text.setText("");
		return text;
	}
	const header = `${title(theme, context.rowState, context.rowId, context.invalidate)}  ${theme.fg("accent", details.agent)}  ${theme.fg("muted", `$${details.usage.cost.toFixed(4)} · ${(details.durationMs / 1000).toFixed(1)}s · ${details.toolCalls} tools`)}`;
	if (!expanded) {
		text.setText(`${header}  ${theme.fg("muted", details.task.replace(/\s+/g, " ").trim())}`);
		return text;
	}
	const lines = [header, theme.fg("muted", `Task: ${cap(details.task, 1000)}`)];
	for (const action of details.actions)
		lines.push(theme.fg(action.error ? "error" : "dim", `${action.error ? "!" : "·"} ${cap(action.summary)}`));
	if (details.response) lines.push(theme.fg("toolOutput", details.response));
	if (details.error) lines.push(theme.fg("error", cap(details.error, 1000)));
	lines.push(theme.fg("muted", `Model: ${details.model} · thinking: ${details.thinkingLevel}`));
	lines.push(
		theme.fg(
			"muted",
			`Tokens: ${details.usage.input} in, ${details.usage.output} out, ${details.usage.cacheRead} cache read, ${details.usage.cacheWrite} cache write · ${details.usage.turns} turns`,
		),
	);
	if (details.omittedActions)
		lines.push(theme.fg("muted", `${details.omittedActions} actions omitted (${details.omittedErrors} errors)`));
	if (details.truncation?.path) lines.push(theme.fg("warning", `Full output: ${details.truncation.path}`));
	text.setText(lines.join("\n"));
	return text;
}
