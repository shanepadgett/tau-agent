import type { DiscoverCandidate, DiscoverResult } from "../queries/discover.ts";
import type { ScanOutcome } from "../scan.ts";
import type { TraversalLimit } from "../traverse.ts";
import { formatPathForDisplay } from "../traverse.ts";

function lineRange(startLine: number, endLine: number): string {
	return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
}

function formatCandidateRows(candidate: DiscoverCandidate): string[] {
	const lines: string[] = [];
	const signature = candidate.signature.length > 0 ? candidate.signature : candidate.name;
	const sigLines = signature.split("\n");
	const first = sigLines[0] ?? candidate.name;
	lines.push(`${lineRange(candidate.startLine, candidate.endLine)} ${candidate.kind}: ${first}`);
	for (let i = 1; i < sigLines.length; i += 1) {
		lines.push(`  ${sigLines[i] ?? ""}`);
	}
	if (candidate.access !== undefined) {
		lines.push(`  ${candidate.access}`);
	}
	return lines;
}

/** One complete file group (path header + candidates). */
export function formatDiscoverFile(path: string, candidates: readonly DiscoverCandidate[], cwd: string): string {
	const lines = [formatPathForDisplay(path, cwd)];
	for (const candidate of candidates) {
		lines.push(...formatCandidateRows(candidate));
	}
	return lines.join("\n");
}

export function formatDiscoverEmpty(): string {
	return "No matching declarations";
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

/** Footers only when something was cut or a budget tripped. */
export function formatDiscoverFooters(result: DiscoverResult): string | undefined {
	const parts: string[] = [];
	if (result.resultLimitReached) {
		parts.push(`candidates omitted (result limit ${result.resultLimit})`);
	}
	if (result.workLimitReached) parts.push("query work");
	if (result.candidateLimitReached) parts.push("query candidates");
	const scan: ScanOutcome | undefined = result.scan;
	if (scan?.limit !== undefined && scan.limit !== "cancelled") {
		parts.push(limitLabel(scan.limit));
	}
	if (parts.length === 0) return undefined;
	return `limits reached: ${parts.join(", ")}`;
}

/** Group candidates by defining file (stable path order from caller). */
export function groupDiscoverByFile(
	candidates: readonly DiscoverCandidate[],
): { path: string; candidates: DiscoverCandidate[] }[] {
	const groups: { path: string; candidates: DiscoverCandidate[] }[] = [];
	const indexByPath = new Map<string, number>();
	for (const candidate of candidates) {
		const existing = indexByPath.get(candidate.path);
		if (existing === undefined) {
			indexByPath.set(candidate.path, groups.length);
			groups.push({ path: candidate.path, candidates: [candidate] });
		} else {
			groups[existing]?.candidates.push(candidate);
		}
	}
	return groups;
}
