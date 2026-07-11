import { type ApplyPatchSummary, deriveStats } from "./executor.ts";

export function formatPatchSummary(summary: ApplyPatchSummary): string {
	const s = deriveStats(summary);
	const lines: string[] = [];
	if (summary.status === "failed") {
		lines.push("No changes applied.");
	} else {
		const parts: string[] = [];
		if (s.linesAdded > 0) parts.push(`+${s.linesAdded}`);
		if (s.linesRemoved > 0) parts.push(`-${s.linesRemoved}`);
		const badge = parts.length > 0 ? ` [${parts.join(" ")}]` : "";
		lines.push(`Applied ${s.completedOperations}/${summary.totalSections} sections.${badge}`);
	}

	for (const path of s.added) lines.push(`A ${path}`);
	for (const path of s.replaced) lines.push(`M ${path}`);
	for (const path of s.updated) lines.push(`M ${path}`);
	for (const path of s.deleted) lines.push(`D ${path}`);
	for (const move of s.moved) lines.push(`R ${move.from} -> ${move.to}`);

	if (summary.failures.length > 0) {
		lines.push("Failures:");
		for (const failure of summary.failures) {
			const kind = failure.kind ? `${failure.kind} ` : "";
			const path = failure.path ?? "";
			const chunk =
				failure.chunkIndex && failure.totalChunks ? ` chunk ${failure.chunkIndex}/${failure.totalChunks}` : "";
			const ctx = failure.contextHint ? ` (context: "${failure.contextHint}")` : "";
			lines.push(`- ${kind}${path}${chunk}: ${failure.message}${ctx}`.trim());
		}
	}

	return lines.join("\n");
}
