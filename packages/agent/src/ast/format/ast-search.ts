import type { AstSearchMatch, AstSearchResult } from "../queries/ast-search.ts";
import type { ScanOutcome } from "../scan.ts";
import type { TraversalLimit } from "../traverse.ts";
import { formatPathForDisplay } from "../traverse.ts";

function lineRange(startLine: number, endLine: number): string {
	return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
}

/** Head-retained line budget per match. resultLimit caps match count, not match size. */
const MATCH_MAX_LINES = 12;

function formatMatchRows(match: AstSearchMatch): string[] {
	const lines: string[] = [];
	const preview = match.text.length > 0 ? match.text : "(empty)";
	const previewLines = preview.split("\n");
	const first = previewLines[0] ?? "(empty)";
	lines.push(`${lineRange(match.startLine, match.endLine)} ${first}`);
	const shown = Math.min(previewLines.length, MATCH_MAX_LINES);
	for (let i = 1; i < shown; i += 1) {
		lines.push(`  ${previewLines[i] ?? ""}`);
	}
	if (previewLines.length > shown) {
		lines.push(`  ... +${previewLines.length - shown} lines`);
	}
	for (const binding of match.bindings) {
		const bindLines = binding.text.split("\n");
		// A multi-line capture is a span, not a value — report its size.
		if (bindLines.length > 1) {
			lines.push(`  $${binding.name} = <${bindLines.length} lines>`);
			continue;
		}
		lines.push(`  $${binding.name} = ${bindLines[0] ?? ""}`);
	}
	if (match.enclosing !== undefined) {
		lines.push(`  in ${match.enclosing.kind} ${match.enclosing.name} L${match.enclosing.startLine}`);
	}
	if (match.parseDegraded) {
		lines.push("  warning: parser recovered with errors");
	}
	return lines;
}

/** One complete file group (path header + matches). */
export function formatAstSearchFile(path: string, matches: readonly AstSearchMatch[], cwd: string): string {
	const lines = [formatPathForDisplay(path, cwd)];
	for (const match of matches) {
		lines.push(...formatMatchRows(match));
	}
	return lines.join("\n");
}

export function formatAstSearchEmpty(): string {
	return "No matches";
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

/** Footers only when something was cut, a budget tripped, or file diagnostics exist. */
export function formatAstSearchFooters(result: AstSearchResult, cwd: string): string | undefined {
	const limits: string[] = [];
	if (result.resultLimitReached) {
		limits.push(`matches omitted (result limit ${result.resultLimit})`);
	}
	const scan: ScanOutcome | undefined = result.scan;
	if (scan?.limit !== undefined && scan.limit !== "cancelled") {
		limits.push(limitLabel(scan.limit));
	}
	const diagnostics = result.fileErrors.map((err) => `${formatPathForDisplay(err.path, cwd)}: ${err.message}`);
	const parts: string[] = [];
	if (limits.length > 0) parts.push(`limits reached: ${limits.join(", ")}`);
	if (diagnostics.length > 0) parts.push(`file errors: ${diagnostics.join("; ")}`);
	if (parts.length === 0) return undefined;
	return parts.join("\n");
}

/** Group matches by file (path order of first appearance). */
export function groupAstSearchByFile(
	matches: readonly AstSearchMatch[],
): { path: string; matches: AstSearchMatch[] }[] {
	const groups: { path: string; matches: AstSearchMatch[] }[] = [];
	const indexByPath = new Map<string, number>();
	for (const match of matches) {
		const existing = indexByPath.get(match.path);
		if (existing === undefined) {
			indexByPath.set(match.path, groups.length);
			groups.push({ path: match.path, matches: [match] });
		} else {
			groups[existing]?.matches.push(match);
		}
	}
	return groups;
}
