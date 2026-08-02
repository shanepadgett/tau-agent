import type { FileDepQueryResult } from "../graph/file-graph.ts";
import { formatPathForDisplay } from "../traverse.ts";

function depthPrefix(depth: number, showDepth: boolean): string {
	return showDepth ? `d${depth} ` : "";
}

function commonDirPrefixLength(split: readonly string[][]): number {
	const first = split[0];
	if (first === undefined || split.length <= 1) return 0;
	let common = 0;
	while (common < first.length - 1) {
		const part = first[common];
		if (part === undefined) break;
		if (!split.every((parts) => parts[common] === part)) break;
		common += 1;
	}
	return common;
}

/** Factor shared directory prefixes into a small indent tree. */
function formatInternalTree(rows: readonly { depth: number; display: string }[], showDepth: boolean): string[] {
	if (rows.length === 0) return [];

	const split = rows.map((row) => row.display.split("/"));
	const common = commonDirPrefixLength(split);
	const first = split[0];
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
	const inRepo: { depth: number; display: string }[] = [];
	const external: { depth: number; id: string }[] = [];
	for (const hit of result.hits) {
		if (hit.kind === "internal") {
			inRepo.push({ depth: hit.depth, display: formatPathForDisplay(hit.path, cwd) });
			continue;
		}
		if (hit.kind === "package") {
			// In-repo directory, listed as a package because file-by-file would flood.
			inRepo.push({
				depth: hit.depth,
				display: `${formatPathForDisplay(hit.dir, cwd)}/ (${hit.fileCount} files)`,
			});
			continue;
		}
		external.push({ depth: hit.depth, id: hit.id });
	}

	if (inRepo.length === 0 && external.length === 0) {
		return emptyLabel;
	}

	const lines: string[] = [];
	lines.push(...formatInternalTree(inRepo, showDepth));

	if (external.length > 0) {
		lines.push("external:");
		for (const hit of external) {
			lines.push(`  ${depthPrefix(hit.depth, showDepth)}${hit.id}`);
		}
	}
	if (result.externalOmitted > 0) {
		lines.push(`  +${result.externalOmitted} more external`);
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
