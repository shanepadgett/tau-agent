import type { FileDepHit, FileDepQueryResult } from "../graph/file-graph.ts";
import { formatPathForDisplay } from "../../traverse.ts";

function depthPrefix(depth: number, showDepth: boolean): string {
	return showDepth ? `d${depth} ` : "";
}

/** Factor shared directory prefixes into a small indent tree. */
function formatInternalTree(
	paths: readonly { depth: number; path: string }[],
	cwd: string,
	showDepth: boolean,
): string[] {
	if (paths.length === 0) return [];
	const rows = paths.map((hit) => ({
		depth: hit.depth,
		display: formatPathForDisplay(hit.path, cwd),
	}));

	// Common directory prefix across displays (posix-ish split on /).
	const split = rows.map((row) => row.display.split("/"));
	let common = 0;
	const first = split[0];
	if (first !== undefined && split.length > 1) {
		while (common < first.length - 1) {
			const part = first[common];
			if (part === undefined) break;
			if (!split.every((parts) => parts[common] === part)) break;
			common += 1;
		}
	}

	const lines: string[] = [];
	if (common > 0 && first !== undefined) {
		lines.push(first.slice(0, common).join("/"));
	}

	for (let i = 0; i < rows.length; i += 1) {
		const row = rows[i];
		const parts = split[i];
		if (row === undefined || parts === undefined) continue;
		const leaf = common > 0 ? parts.slice(common).join("/") : row.display;
		const indent = common > 0 ? "  " : "";
		lines.push(`${indent}${depthPrefix(row.depth, showDepth)}${leaf}`);
	}
	return lines;
}

export function formatDepsResult(result: FileDepQueryResult, cwd: string, emptyLabel: string): string {
	const showDepth = result.depth > 1;
	const internal = result.hits
		.filter((hit): hit is FileDepHit & { path: string } => hit.path !== undefined)
		.map((hit) => ({ depth: hit.depth, path: hit.path }));
	const external = result.hits
		.filter((hit): hit is FileDepHit & { externalId: string } => hit.externalId !== undefined)
		.map((hit) => ({ depth: hit.depth, id: hit.externalId }));

	if (internal.length === 0 && external.length === 0) {
		return emptyLabel;
	}

	const lines: string[] = [];
	lines.push(...formatInternalTree(internal, cwd, showDepth));

	if (external.length > 0) {
		if (lines.length > 0) lines.push("external:");
		else lines.push("external:");
		for (const hit of external) {
			lines.push(`  ${depthPrefix(hit.depth, showDepth)}${hit.id}`);
		}
	}

	if (result.resultLimitReached) {
		lines.push(`omitted (result limit ${result.resultLimit})`);
	}

	return lines.join("\n");
}

export function formatDepsEmpty(): string {
	return "No file dependencies";
}

export function formatReverseDepsEmpty(): string {
	return "No reverse file dependencies";
}
