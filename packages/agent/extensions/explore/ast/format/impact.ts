import { formatPathForDisplay } from "../../traverse.ts";
import type { ImpactFileRow, ImpactResult, ImpactSection, ImpactSiteRow, ImpactTarget } from "../queries/impact.ts";
import { compositeSectionBlocks, type CompositeBlock } from "./composite.ts";
import { formatCandidateList } from "./relationships.ts";

function formatTargetHeader(target: ImpactTarget, cwd: string): string {
	const path = formatPathForDisplay(target.path, cwd);
	return `${target.qualifiedName || target.name}  ${target.kind}  ${path}:${target.startLine}`;
}

function formatSiteRow(row: ImpactSiteRow): string {
	const certainty = row.certainty === "exact" ? "" : `  ${row.certainty}`;
	const preview = row.preview.length > 0 ? `  ${row.preview}` : "";
	const name = row.name.length > 0 ? `  ${row.name}` : "";
	return `  L${row.line}  ${row.siteKind}${name}${certainty}${preview}`;
}

function formatFileRow(row: ImpactFileRow, cwd: string, showDepth: boolean): string {
	const depth = showDepth ? `d${row.depth} ` : "";
	if (row.path !== undefined) {
		return `  ${depth}${formatPathForDisplay(row.path, cwd)}`;
	}
	return `  ${depth}${row.externalId ?? "?"}`;
}

function formatSection(section: ImpactSection, cwd: string): string[] {
	const lines = [`${section.label}:`];
	const showDepth = section.id === "transitiveDependents";
	const siteRows = section.rows.filter((row): row is ImpactSiteRow => row.kind === "site");
	const fileRows = section.rows.filter((row): row is ImpactFileRow => row.kind === "file");

	if (siteRows.length > 0) {
		let currentPath = "";
		for (const row of siteRows) {
			if (row.path !== currentPath) {
				currentPath = row.path;
				lines.push(formatPathForDisplay(row.path, cwd));
			}
			lines.push(formatSiteRow(row));
		}
	}

	if (fileRows.length > 0) {
		const internal = fileRows.filter((row) => row.path !== undefined);
		const external = fileRows.filter((row) => row.externalId !== undefined);
		for (const row of internal) {
			lines.push(formatFileRow(row, cwd, showDepth));
		}
		if (external.length > 0) {
			lines.push("  external:");
			for (const row of external) {
				lines.push(`  ${formatFileRow(row, cwd, showDepth).trimStart()}`);
			}
		}
	}

	if (section.omitted) {
		lines.push(`  omitted (limit ${section.limit})`);
	}
	return lines;
}

function formatResolved(result: Extract<ImpactResult, { kind: "resolved" }>, cwd: string): string {
	const lines = [formatTargetHeader(result.target, cwd)];
	if (result.sections.length === 0) {
		lines.push("No impact edges.");
	} else {
		for (const section of result.sections) {
			lines.push("");
			lines.push(...formatSection(section, cwd));
		}
	}
	for (const note of result.notes) {
		lines.push(note);
	}
	if (result.parseDegraded) {
		lines.push("parser: degraded on at least one file");
	}
	return lines.join("\n");
}

export function formatImpactResult(result: ImpactResult, cwd: string): string {
	if (result.kind === "error") return result.message;
	if (result.kind === "notFound") return "No matching declaration.";
	if (result.kind === "candidates") return formatCandidateList(result.candidates, cwd);
	return formatResolved(result, cwd);
}

export function impactSectionBlocks(
	result: Extract<ImpactResult, { kind: "resolved" }>,
	cwd: string,
): CompositeBlock[] {
	const footers = [...result.notes];
	if (result.parseDegraded) footers.push("parser: degraded on at least one file");
	return compositeSectionBlocks({
		header: formatTargetHeader(result.target, cwd),
		emptyLabel: "No impact edges.",
		sections: result.sections.map((section) => ({
			id: section.id,
			label: section.label,
			text: formatSection(section, cwd).join("\n"),
		})),
		footers,
	});
}
