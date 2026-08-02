import { type ApplyPatchStats, type ApplyPatchSummary, deriveStats } from "./executor.ts";
import type { PatchFailure } from "./parser.ts";

function formatStatusLine(summary: ApplyPatchSummary, stats: ApplyPatchStats): string {
	if (summary.status === "failed") return "No changes applied.";
	const parts: string[] = [];
	if (stats.linesAdded > 0) parts.push(`+${stats.linesAdded}`);
	if (stats.linesRemoved > 0) parts.push(`-${stats.linesRemoved}`);
	const badge = parts.length > 0 ? ` [${parts.join(" ")}]` : "";
	return `Applied ${stats.completedOperations}/${summary.totalSections} sections.${badge}`;
}

function formatChangeLines(stats: ApplyPatchStats): string[] {
	const lines: string[] = [];
	for (const path of stats.added) lines.push(`A ${path}`);
	for (const path of stats.replaced) lines.push(`M ${path}`);
	for (const path of stats.updated) lines.push(`M ${path}`);
	for (const path of stats.deleted) lines.push(`D ${path}`);
	for (const move of stats.moved) lines.push(`R ${move.from} -> ${move.to}`);
	return lines;
}

function formatFailureLine(failure: PatchFailure): string {
	const kind = failure.kind ? `${failure.kind} ` : "";
	const path = failure.path ?? "";
	const chunk = failure.chunkIndex && failure.totalChunks ? ` chunk ${failure.chunkIndex}/${failure.totalChunks}` : "";
	const ctx = failure.contextHint ? ` (context: "${failure.contextHint}")` : "";
	return `- ${kind}${path}${chunk}: ${failure.message}${ctx}`.trim();
}

export function formatPatchSummary(summary: ApplyPatchSummary): string {
	const stats = deriveStats(summary);
	const lines = [formatStatusLine(summary, stats), ...formatChangeLines(stats)];
	if (summary.failures.length > 0) {
		lines.push("Failures:");
		for (const failure of summary.failures) lines.push(formatFailureLine(failure));
	}
	return lines.join("\n");
}
