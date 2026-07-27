import type { OutlineFileView, OutlineRow } from "../queries/outline.ts";
import type { ScanOutcome } from "../scan.ts";
import type { TraversalLimit } from "../../traverse.ts";
import { formatPathForDisplay } from "../../traverse.ts";

function lineRange(startLine: number, endLine: number): string {
	return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
}

function formatRow(row: OutlineRow): string[] {
	const indent = "  ".repeat(row.depth);
	const lines: string[] = [];
	if (row.docs !== undefined && row.docs.length > 0) {
		for (const docLine of row.docs.replace(/\s+$/u, "").split("\n")) {
			lines.push(`${indent}${docLine}`);
		}
	}
	const signature = row.signature.replace(/\s+$/u, "");
	const sigLines = signature.length > 0 ? signature.split("\n") : [row.name];
	const first = sigLines[0] ?? row.name;
	lines.push(`${indent}${lineRange(row.startLine, row.endLine)}: ${first}`);
	for (let i = 1; i < sigLines.length; i += 1) {
		lines.push(`${indent}${sigLines[i] ?? ""}`);
	}
	return lines;
}

/** One complete outline unit (optional path header + rows). */
export function formatOutlineFile(view: OutlineFileView, cwd: string, includePathHeader: boolean): string {
	const lines: string[] = [];
	if (includePathHeader) lines.push(formatPathForDisplay(view.path, cwd));
	if (view.parseDegraded) {
		lines.push("warning: parser recovered with errors");
	}
	if (view.rows.length === 0) {
		lines.push("No declarations");
	} else {
		for (const row of view.rows) lines.push(...formatRow(row));
	}
	return lines.join("\n");
}

export function formatOutlineEmpty(names: readonly string[]): string {
	return names.length > 0 ? "No matching declarations" : "No declarations";
}

function limitLabel(limit: TraversalLimit): string {
	switch (limit) {
		case "maxFiles":
			return "file count";
		case "maxSourceBytes":
			return "source bytes";
		case "maxDepth":
			return "depth";
		case "maxElapsedMs":
			return "elapsed time";
		case "cancelled":
			return "cancelled";
	}
}

/** Budget/limit footer line when a recursive scan stopped early. */
export function formatOutlineBudgetFooter(outcome: ScanOutcome): string | undefined {
	if (outcome.limit === undefined || outcome.limit === "cancelled") return undefined;
	return `limits reached: ${limitLabel(outcome.limit)}`;
}
