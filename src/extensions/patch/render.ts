import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ApplyPatchSummary } from "./executor.ts";

// renderCall owns only the pre-execution streaming preview. Once execution starts, pi stacks
// renderResult below renderCall in the same container, so yielding here avoids a duplicated op list.
// renderResult receives partial summaries via result.details on each onUpdate, so the live indicator
// walk lives there natively — no progress stash needed.

interface PreviewOp {
	sectionIndex: number;
	kind: "add" | "update" | "delete";
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
		const addMatch = line.match(/^\*\*\* (?:Add|Replace) File: (.+)$/);
		if (addMatch) {
			current = { sectionIndex: ops.length + 1, kind: "add", path: addMatch[1]!, linesAdded: 0, linesRemoved: 0 };
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

		if (current.kind === "add") {
			if (line.startsWith("+")) current.linesAdded += 1;
			continue;
		}
		if (current.kind !== "update") continue;
		if (line.startsWith("+")) current.linesAdded += 1;
		else if (line.startsWith("-")) current.linesRemoved += 1;
	}

	return ops;
}

function touchedFileCount(preview: PreviewOp[]): number {
	return new Set(preview.map((op) => op.moveTo ?? op.path)).size;
}

function statsBadge(summary: ApplyPatchSummary | undefined, preview: PreviewOp[], theme: Theme): string {
	const changedFileCount = summary ? new Set(summary.changes.map((c) => c.move?.to ?? c.path)).size : 0;
	const fileCount = summary && changedFileCount > 0 ? changedFileCount : touchedFileCount(preview);

	const linesAdded = summary ? summary.linesAdded : preview.reduce((s, op) => s + op.linesAdded, 0);
	const linesRemoved = summary ? summary.linesRemoved : preview.reduce((s, op) => s + op.linesRemoved, 0);
	const moves = summary ? summary.moved.length : preview.filter((op) => op.moveTo).length;

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

function indicator(status: OpStatus | undefined, theme: Theme): string {
	if (status === "applied") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "!");
	return theme.fg("muted", "…");
}

function renderOpLine(op: PreviewOp, status: OpStatus | undefined, theme: Theme): string {
	const label = `${theme.fg("muted", "  ")}${theme.fg("text", opLabel(op))}`;
	const ind = indicator(status, theme);
	return ind ? `${label}  ${ind}` : label;
}

interface RenderCallContext {
	expanded: boolean;
	executionStarted: boolean;
}

export function renderPatchCall(args: { input?: string } | undefined, theme: Theme, context: RenderCallContext): Text {
	// Once execution starts, renderResult owns the view (it gets the live summary). Yield to avoid
	// a duplicated op list, since pi stacks both renderers in the same container.
	if (context.executionStarted) return new Text("", 0, 0);

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
