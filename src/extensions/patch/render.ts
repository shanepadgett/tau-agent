import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { type ApplyPatchSummary, deriveStats } from "./executor.ts";

// renderCall owns only the pre-execution streaming preview. Once execution starts, pi stacks
// renderResult below renderCall in the same container, so yielding here avoids a duplicated op list.
// renderResult receives partial summaries via result.details on each onUpdate, so the live indicator
// walk lives there natively — no progress stash needed.

interface PreviewOp {
	sectionIndex: number;
	kind: "add" | "replace" | "update" | "delete";
	path: string;
	moveTo?: string;
	linesAdded: number;
	linesRemoved: number;
}

const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const REPLACE_FILE_MARKER = "*** Replace File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";

function topLevelDirective(line: string): string {
	return line.trim();
}

function updateDirective(line: string): string {
	return line.trimEnd();
}

function pathAfter(value: string, prefix: string): string | undefined {
	if (!value.startsWith(prefix)) return undefined;
	const path = value.slice(prefix.length).trim();
	return path.length > 0 ? path : undefined;
}

function startPreviewOp(ops: PreviewOp[], kind: PreviewOp["kind"], path: string): PreviewOp {
	const op = { sectionIndex: ops.length + 1, kind, path, linesAdded: 0, linesRemoved: 0 };
	ops.push(op);
	return op;
}

// Tolerant preview scan — never throws, display-oriented (partial patches during streaming).
function scanPreview(input: string | undefined): PreviewOp[] {
	if (typeof input !== "string" || !input) return [];
	const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const ops: PreviewOp[] = [];
	let current: PreviewOp | undefined;

	for (const line of lines) {
		const value = current?.kind === "update" ? updateDirective(line) : topLevelDirective(line);
		if (value === END_PATCH_MARKER) break;

		const addPath = pathAfter(value, ADD_FILE_MARKER);
		if (addPath !== undefined) {
			current = startPreviewOp(ops, "add", addPath);
			continue;
		}

		const replacePath = pathAfter(value, REPLACE_FILE_MARKER);
		if (replacePath !== undefined) {
			current = startPreviewOp(ops, "replace", replacePath);
			continue;
		}

		const deletePath = pathAfter(value, DELETE_FILE_MARKER);
		if (deletePath !== undefined) {
			current = startPreviewOp(ops, "delete", deletePath);
			continue;
		}

		const updatePath = pathAfter(value, UPDATE_FILE_MARKER);
		if (updatePath !== undefined) {
			current = startPreviewOp(ops, "update", updatePath);
			continue;
		}

		if (!current) continue;

		if (current.kind === "update") {
			const movePath = pathAfter(updateDirective(line), MOVE_TO_MARKER);
			if (movePath !== undefined) {
				current.moveTo = movePath;
				continue;
			}
			if (line.startsWith("+")) current.linesAdded += 1;
			else if (line.startsWith("-")) current.linesRemoved += 1;
			continue;
		}

		if (current.kind === "add" || current.kind === "replace") {
			if (line.startsWith("+")) current.linesAdded += 1;
		}
	}

	return ops;
}

function statsBadge(summary: ApplyPatchSummary | undefined, preview: PreviewOp[], theme: Theme): string {
	let fileCount: number;
	let linesAdded: number;
	let linesRemoved: number;
	let moves: number;

	if (summary && summary.changes.length > 0) {
		const s = deriveStats(summary);
		fileCount = new Set(summary.changes.map((c) => c.move?.to ?? c.path)).size;
		linesAdded = s.linesAdded;
		linesRemoved = s.linesRemoved;
		moves = s.moved.length;
	} else {
		fileCount = new Set(preview.map((op) => op.moveTo ?? op.path)).size;
		linesAdded = preview.reduce((sum, op) => sum + op.linesAdded, 0);
		linesRemoved = preview.reduce((sum, op) => sum + op.linesRemoved, 0);
		moves = preview.filter((op) => op.moveTo).length;
	}

	const stats = [
		linesAdded > 0 ? `+${linesAdded}` : "",
		linesRemoved > 0 ? `-${linesRemoved}` : "",
		moves > 0 ? `>${moves}` : "",
	]
		.filter(Boolean)
		.join(" ");

	const badge = stats
		? `${fileCount} file${fileCount === 1 ? "" : "s"} · ${stats}`
		: `${fileCount} file${fileCount === 1 ? "" : "s"}`;
	return theme.fg("accent", badge);
}

function opLabel(op: PreviewOp): string {
	if (op.moveTo) return `Move   ${op.path} → ${op.moveTo}`;
	if (op.kind === "add") return `Add    ${op.path}`;
	if (op.kind === "replace") return `Replace ${op.path}`;
	if (op.kind === "delete") return `Delete ${op.path}`;
	return `Edit   ${op.path}`;
}

type OpStatus = "pending" | "applied" | "failed";

function deriveStatuses(summary: ApplyPatchSummary): Map<number, OpStatus> {
	const map = new Map<number, OpStatus>();
	for (const change of summary.changes) map.set(change.sectionIndex, "applied");
	for (const failure of summary.failures) {
		if (failure.sectionIndex > 0) map.set(failure.sectionIndex, "failed");
	}
	return map;
}

function renderOpLine(op: PreviewOp, status: OpStatus | undefined, theme: Theme): string {
	const label = `${theme.fg("muted", "  ")}${theme.fg("text", opLabel(op))}`;
	const ind =
		status === "applied"
			? theme.fg("success", "✓")
			: status === "failed"
				? theme.fg("error", "!")
				: theme.fg("muted", "…");
	return ind ? `${label}  ${ind}` : label;
}

interface RenderCallContext {
	expanded: boolean;
	executionStarted: boolean;
	isPartial: boolean;
	lastComponent?: unknown;
	rowState: ToolRowStateStore;
	toolCallId: string;
	invalidate: () => void;
}

function patchTitle(theme: Theme, context: Pick<RenderCallContext, "rowState" | "toolCallId" | "invalidate">): string {
	context.rowState.watch(context.toolCallId, context.invalidate);
	return formatToolRowTitle(context.rowState, context.toolCallId, "patch", theme);
}

function textComponent(lastComponent: unknown): Text {
	return (lastComponent as Text | undefined) ?? new Text("", 0, 0);
}

export function renderPatchCall(args: { input?: string } | undefined, theme: Theme, context: RenderCallContext): Text {
	const text = textComponent(context.lastComponent);
	// Once execution starts, renderResult owns the view (it gets the live summary). Yield to avoid
	// a duplicated op list, since pi stacks both renderers in the same container.
	if (context.executionStarted || !context.isPartial) {
		text.setText("");
		return text;
	}

	const input = args?.input;
	const preview = scanPreview(input);
	const header = `${patchTitle(theme, context)}  ${statsBadge(undefined, preview, theme)}`;

	if (context.expanded) {
		const raw = typeof input === "string" ? input.replace(/\r\n/g, "\n").trim() : "";
		text.setText(raw ? `${header}\n${theme.fg("muted", raw)}` : header);
		return text;
	}

	if (preview.length === 0) {
		text.setText(header);
		return text;
	}
	const lines = preview.map((op) => renderOpLine(op, "pending", theme));
	text.setText([header, ...lines].join("\n"));
	return text;
}

export function renderPatchResult(
	result: { details?: ApplyPatchSummary },
	options: { expanded: boolean },
	theme: Theme,
	context: {
		expanded: boolean;
		args?: { input?: string };
		lastComponent?: unknown;
		rowState: ToolRowStateStore;
		toolCallId: string;
		invalidate: () => void;
	},
): Text {
	const text = textComponent(context.lastComponent);
	const summary = result.details;
	if (!summary) {
		text.setText("");
		return text;
	}
	const preview = scanPreview(context.args?.input);
	const header = `${patchTitle(theme, context)}  ${statsBadge(summary, preview, theme)}`;
	const statuses = deriveStatuses(summary);

	if (options.expanded) {
		const raw = context.args?.input?.replace(/\r\n/g, "\n").trim() ?? "";
		const sections = [header];
		if (raw) sections.push(theme.fg("muted", raw));
		text.setText(sections.join("\n"));
		return text;
	}

	const lines = preview.map((op) => renderOpLine(op, statuses.get(op.sectionIndex), theme));
	text.setText([header, ...lines].join("\n"));
	return text;
}
