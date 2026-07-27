import type { ShowBatch, ShowBlock } from "../queries/show.ts";
import { formatPathForDisplay } from "../../traverse.ts";

function lineRange(startLine: number, endLine: number): string {
	return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
}

function formatBlock(block: ShowBlock, cwd: string, includePath: boolean): string {
	const lines: string[] = [];
	if (includePath) lines.push(formatPathForDisplay(block.path, cwd));
	lines.push(`${lineRange(block.startLine, block.endLine)}: ${block.name}`);
	for (const warning of block.warnings) {
		lines.push(`warning: ${warning}`);
	}
	lines.push(block.text);
	return lines.join("\n");
}

/**
 * Exact source blocks.
 * Single block: no path chrome. Multi-block: path header when the path changes.
 */
export function formatShowBatch(batch: ShowBatch, cwd: string): string {
	if (batch.blocks.length === 0) return "";
	if (batch.blocks.length === 1) {
		const only = batch.blocks[0];
		if (only === undefined) return "";
		return formatBlock(only, cwd, false);
	}
	const parts: string[] = [];
	let lastPath: string | undefined;
	for (const block of batch.blocks) {
		const includePath = block.path !== lastPath;
		lastPath = block.path;
		parts.push(formatBlock(block, cwd, includePath));
	}
	return parts.join("\n\n");
}
