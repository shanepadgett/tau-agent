import type { Candidate } from "../identity.ts";
import type { RelationshipQueryResult, RelationshipSite, RelationshipTarget } from "../graph/relationships.ts";
import { compactSignature } from "../slice.ts";
import { formatPathForDisplay } from "../traverse.ts";

function candidateParts(candidate: Candidate, cwd: string): { path: string; signature: string } {
	return {
		path: formatPathForDisplay(candidate.path, cwd),
		signature: compactSignature(candidate.signature),
	};
}

function formatCompetitors(competitors: readonly Candidate[], cwd: string): string[] {
	const lines: string[] = [];
	for (const c of competitors) {
		const { path, signature: short } = candidateParts(c, cwd);
		lines.push(`    - ${path}:${c.startLine}  ${c.kind} ${c.qualifiedName || c.name}  ${short}`);
	}
	return lines;
}

function formatSiteRow(site: RelationshipSite): string {
	const certainty = site.certainty === "exact" ? "" : `  ${site.certainty}`;
	const preview = site.preview.length > 0 ? `  ${site.preview}` : "";
	return `  L${site.line}  ${site.kind}${certainty}${preview}`;
}

function formatResolved(
	target: RelationshipTarget,
	sites: readonly RelationshipSite[],
	cwd: string,
	resultLimit: number,
	resultLimitReached: boolean,
	parseDegraded: boolean,
): string {
	const path = formatPathForDisplay(target.path, cwd);
	const header = `${target.qualifiedName || target.name}  ${target.kind}  ${path}:${target.startLine}`;
	if (sites.length === 0) {
		const lines = [header, "No relationship sites."];
		if (parseDegraded) lines.push("parser: degraded on at least one file");
		return lines.join("\n");
	}

	const lines: string[] = [header, ""];
	let currentPath = "";
	for (const site of sites) {
		if (site.path !== currentPath) {
			currentPath = site.path;
			lines.push(formatPathForDisplay(site.path, cwd));
		}
		lines.push(formatSiteRow(site));
		if (site.competitors.length > 0) {
			lines.push("  competitors:");
			lines.push(...formatCompetitors(site.competitors, cwd));
		}
	}

	if (resultLimitReached) lines.push(`omitted (result limit ${resultLimit})`);
	if (parseDegraded) lines.push("parser: degraded on at least one file");
	return lines.join("\n");
}

export function formatCandidateList(candidates: readonly Candidate[], cwd: string): string {
	const lines = ["Ambiguous target — disambiguate with targetPath or line:", ""];
	for (const c of candidates) {
		const { path, signature: short } = candidateParts(c, cwd);
		lines.push(`${path}:${c.startLine}  ${c.kind} ${c.qualifiedName || c.name}`);
		if (short.length > 0) lines.push(`  ${short}`);
	}
	return lines.join("\n");
}

export function formatRelationshipResult(result: RelationshipQueryResult, cwd: string): string {
	if (result.kind === "error") return result.message;
	if (result.kind === "notFound") return "No matching declaration.";
	if (result.kind === "candidates") return formatCandidateList(result.candidates, cwd);
	return formatResolved(
		result.target,
		result.sites,
		cwd,
		result.resultLimit,
		result.resultLimitReached,
		result.parseDegraded,
	);
}
