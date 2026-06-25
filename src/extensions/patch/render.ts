import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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

// Tolerant preview scan — never throws, display-oriented (partial patches during streaming).
function scanPreview(input: string | undefined): PreviewOp[] {
	if (typeof input !== "string" || !input) return [];
	const lines = input.replace(/\r\n/g, "\n").split("\n");
	const ops: PreviewOp[] = [];
	let current: PreviewOp | undefined;

	for (const line of lines) {
		if (line === "*** End Patch") break;
		const addMatch = line.match(/^\*\*\* (Add|Replace) File: (.+)$/);
		if (addMatch) {
			current = {
				sectionIndex: ops.length + 1,
				kind: addMatch[1] === "Replace" ? "replace" : "add",
				path: addMatch[2]!,
				linesAdded: 0,
				linesRemoved: 0,
			};
			ops.push(current);
			continue;
		}
		const delMatch = line.match(/^\*\*\* Delete File: (.+)$/);
		if (delMatch) {
			current = { sectionIndex: ops.length + 1, kind: "delete", path: delMatch[1]!, linesAdded: 0, linesRemoved: 0 };
			ops.push(current);
			continue;
		}
		const updMatch = line.match(/^\*\*\* Update File: (.+)$/);
		if (updMatch) {
			current = { sectionIndex: ops.length + 1, kind: "update", path: updMatch[1]!, linesAdded: 0, linesRemoved: 0 };
			ops.push(current);
			continue;
		}
		if (!current) continue;

		const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
		if (moveMatch && current.kind === "update") {
			current.moveTo = moveMatch[1];
			continue;
		}

		if (current.kind === "add" || current.kind === "replace") {
			if (line.startsWith("+")) current.linesAdded += 1;
			continue;
		}
		if (current.kind !== "update") continue;
		if (line.startsWith("+")) current.linesAdded += 1;
		else if (line.startsWith("-")) current.linesRemoved += 1;
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
}

export function renderPatchCall(args: { input?: string } | undefined, theme: Theme, context: RenderCallContext): Text {
	// Once execution starts, renderResult owns the view (it gets the live summary). Yield to avoid
	// a duplicated op list, since pi stacks both renderers in the same container.
	if (context.executionStarted || !context.isPartial) return new Text("", 0, 0);

	const input = args?.input;
	const preview = scanPreview(input);
	const header = `${theme.fg("toolTitle", theme.bold("patch"))}  ${statsBadge(undefined, preview, theme)}`;

	if (context.expanded) {
		const raw = typeof input === "string" ? input.replace(/\r\n/g, "\n").trim() : "";
		return new Text(raw ? `${header}\n${theme.fg("muted", raw)}` : header, 0, 0);
	}

	if (preview.length === 0) return new Text(header, 0, 0);
	const lines = preview.map((op) => renderOpLine(op, "pending", theme));
	return new Text([header, ...lines].join("\n"), 0, 0);
}

export function renderPatchResult(
	result: { details?: ApplyPatchSummary },
	options: { expanded: boolean },
	theme: Theme,
	context: { expanded: boolean; args?: { input?: string } },
): Text {
	const summary = result.details;
	if (!summary) return new Text("", 0, 0);
	const preview = scanPreview(context.args?.input);
	const header = `${theme.fg("toolTitle", theme.bold("patch"))}  ${statsBadge(summary, preview, theme)}`;
	const statuses = deriveStatuses(summary);

	if (options.expanded) {
		const raw = context.args?.input?.replace(/\r\n/g, "\n").trim() ?? "";
		const sections = [header];
		if (raw) sections.push(theme.fg("muted", raw));
		return new Text(sections.join("\n"), 0, 0);
	}

	const lines = preview.map((op) => renderOpLine(op, statuses.get(op.sectionIndex), theme));
	return new Text([header, ...lines].join("\n"), 0, 0);
}
