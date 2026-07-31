import { formatPathForDisplay } from "../traverse.ts";
import type { ContextEntry, ContextGroup, ContextResult, ContextTarget } from "../queries/context.ts";
import { compositeSectionBlocks, type CompositeBlock } from "./composite.ts";
import { formatTargetedResult } from "./targeted-result.ts";

function formatTargetHeader(target: ContextTarget, budget: number, used: number, cwd: string): string {
	const path = formatPathForDisplay(target.path, cwd);
	return `${target.qualifiedName || target.name}  ${target.kind}  ${path}:${target.startLine}  budget=${budget} used=${used}`;
}

function formatEntry(entry: ContextEntry, cwd: string): string {
	const path = formatPathForDisplay(entry.path, cwd);
	const flags = entry.flags.length > 0 ? `  ${entry.flags.join(",")}` : "";
	const head = `${path}:${entry.startLine}  ${entry.kind} ${entry.qualifiedName || entry.name}  ~${entry.tokens}tok ${entry.view}${flags}`;
	return `${head}\n${entry.text}`;
}

function formatGroup(group: ContextGroup, cwd: string): string {
	const lines = [`${group.label}:`];
	for (const entry of group.entries) {
		lines.push(formatEntry(entry, cwd));
		lines.push("");
	}
	if (lines.at(-1) === "") lines.pop();
	return lines.join("\n");
}

function formatResolved(result: Extract<ContextResult, { kind: "resolved" }>, cwd: string): string {
	const lines = [formatTargetHeader(result.target, result.budget, result.used, cwd)];
	if (result.groups.length === 0) {
		lines.push("No context entries.");
	} else {
		for (const group of result.groups) {
			lines.push("");
			lines.push(formatGroup(group, cwd));
		}
	}
	if (result.truncated) {
		lines.push("");
		lines.push("truncated: budget exhausted or entry skipped");
	}
	return lines.join("\n");
}

export function formatContextResult(result: ContextResult, cwd: string): string {
	return formatTargetedResult(result, cwd, formatResolved);
}

export function contextSectionBlocks(
	result: Extract<ContextResult, { kind: "resolved" }>,
	cwd: string,
): CompositeBlock[] {
	return compositeSectionBlocks({
		header: formatTargetHeader(result.target, result.budget, result.used, cwd),
		emptyLabel: "No context entries.",
		sections: result.groups.map((group) => ({
			id: group.id,
			label: group.label,
			text: formatGroup(group, cwd),
		})),
		footers: result.truncated ? ["truncated: budget exhausted or entry skipped"] : [],
	});
}
