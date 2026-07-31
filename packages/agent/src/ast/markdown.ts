import type { ExtractResult } from "./adapter.ts";
import type { Decl } from "./ir.ts";

const ATX_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const OPEN_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

type LineInfo = {
	/** 1-indexed. */
	line: number;
	text: string;
	/** Offset of the first code unit of this line. */
	startOffset: number;
	/** Offset just past the line content (before newline, or EOF). */
	endOffset: number;
	/** Offset of the first code unit of the following line (or EOF). */
	nextOffset: number;
};

type OpenHeading = {
	decl: Decl;
	depth: number;
};

function splitLines(source: string): LineInfo[] {
	if (source.length === 0) {
		return [{ line: 1, text: "", startOffset: 0, endOffset: 0, nextOffset: 0 }];
	}

	const lines: LineInfo[] = [];
	let line = 1;
	let i = 0;

	while (i < source.length) {
		const start = i;
		while (i < source.length) {
			const ch = source.charCodeAt(i);
			if (ch === 10 || ch === 13) break;
			i += 1;
		}
		const end = i;
		let next = i;
		if (next < source.length && source.charCodeAt(next) === 13) {
			next += 1;
		}
		if (next < source.length && source.charCodeAt(next) === 10) {
			next += 1;
		}
		lines.push({ line, text: source.slice(start, end), startOffset: start, endOffset: end, nextOffset: next });
		line += 1;
		i = next;
	}

	return lines;
}

function closeOpen(stack: OpenHeading[], depth: number, endLine: number, endOffset: number): void {
	while (stack.length > 0) {
		const top = stack[stack.length - 1];
		if (top === undefined || top.depth < depth) break;
		stack.pop();
		const decl = top.decl;
		decl.endLine = endLine;
		decl.endOffset = endOffset;
		if (decl.bodyStartOffset !== undefined) {
			decl.bodyEndOffset = endOffset;
			if (decl.bodyStartOffset >= endOffset) {
				delete decl.bodyStartOffset;
				delete decl.bodyEndOffset;
			}
		}
	}
}

/**
 * ATX heading scanner. Fenced code (``` / ~~~, length ≥ 3, matching closer) is not heading material.
 * Section range runs to the line before the next same-or-shallower heading, else EOF.
 */
export function extractMarkdown(source: string): ExtractResult {
	const lines = splitLines(source);
	const roots: Decl[] = [];
	const stack: OpenHeading[] = [];
	let inFence: { char: "`" | "~"; length: number } | undefined;

	for (const info of lines) {
		if (inFence !== undefined) {
			const close = info.text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
			const marker = close?.[1];
			if (marker !== undefined && marker[0] === inFence.char && marker.length >= inFence.length) {
				inFence = undefined;
			}
			continue;
		}

		const fence = info.text.match(OPEN_FENCE);
		const fenceMarker = fence?.[2];
		if (fenceMarker !== undefined) {
			const char = fenceMarker[0] === "~" ? "~" : "`";
			inFence = { char, length: fenceMarker.length };
			continue;
		}

		const heading = info.text.match(ATX_HEADING);
		if (heading === null) continue;
		const hashes = heading[1];
		if (hashes === undefined) continue;
		const depth = hashes.length;
		const name = (heading[2] ?? "").trim();
		if (name.length === 0) continue;

		const prev = info.line > 1 ? lines[info.line - 2] : undefined;
		const closeEndLine = prev === undefined ? info.line : prev.line;
		closeOpen(stack, depth, closeEndLine, info.startOffset);

		const parent = stack[stack.length - 1];
		const qualifiedName = parent === undefined ? name : `${parent.decl.qualifiedName}.${name}`;
		const decl: Decl = {
			kind: "heading",
			name,
			qualifiedName,
			startLine: info.line,
			endLine: info.line,
			startOffset: info.startOffset,
			endOffset: info.endOffset,
			signatureEndOffset: info.endOffset,
			bodyStartOffset: info.nextOffset,
			bodyEndOffset: info.nextOffset,
			visibility: "public",
			exported: true,
			children: [],
			calls: [],
			bases: [],
		};

		if (parent === undefined) roots.push(decl);
		else parent.decl.children.push(decl);
		stack.push({ decl, depth });
	}

	const last = lines[lines.length - 1];
	const eofLine = last === undefined ? 1 : last.line;
	const eofOffset = last === undefined ? 0 : last.nextOffset;
	closeOpen(stack, 1, eofLine, eofOffset);

	return { decls: roots, imports: [], fileCalls: [] };
}
