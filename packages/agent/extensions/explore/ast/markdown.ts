import type { ExtractResult } from "./adapter.ts";
import type { Decl } from "./ir.ts";

const ATX_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const OPEN_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

type LineInfo = {
	/** 1-indexed. */
	line: number;
	text: string;
	/** UTF-8 offset of first byte of this line. */
	startByte: number;
	/** UTF-8 offset of first byte after line content (before newline, or EOF). */
	endByte: number;
	/** UTF-8 offset of first byte of the following line (or EOF). */
	nextByte: number;
};

type OpenHeading = {
	decl: Decl;
	depth: number;
};

function utf8Len(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function splitLines(source: string): LineInfo[] {
	if (source.length === 0) {
		return [{ line: 1, text: "", startByte: 0, endByte: 0, nextByte: 0 }];
	}

	const lines: LineInfo[] = [];
	let line = 1;
	let byte = 0;
	let i = 0;

	while (i < source.length) {
		const start = i;
		const startByte = byte;
		while (i < source.length) {
			const ch = source.charCodeAt(i);
			if (ch === 10 || ch === 13) break;
			i += 1;
		}
		const text = source.slice(start, i);
		const endByte = startByte + utf8Len(text);
		let next = i;
		let nextByte = endByte;
		if (next < source.length && source.charCodeAt(next) === 13) {
			next += 1;
			nextByte += 1;
		}
		if (next < source.length && source.charCodeAt(next) === 10) {
			next += 1;
			nextByte += 1;
		}
		lines.push({ line, text, startByte, endByte, nextByte });
		line += 1;
		byte = nextByte;
		i = next;
	}

	return lines;
}

function closeOpen(stack: OpenHeading[], depth: number, endLine: number, endByte: number): void {
	while (stack.length > 0) {
		const top = stack[stack.length - 1];
		if (top === undefined || top.depth < depth) break;
		stack.pop();
		const decl = top.decl;
		decl.endLine = endLine;
		decl.endByte = endByte;
		if (decl.bodyStartByte !== undefined) {
			decl.bodyEndByte = endByte;
			if (decl.bodyStartByte >= endByte) {
				delete decl.bodyStartByte;
				delete decl.bodyEndByte;
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
		closeOpen(stack, depth, closeEndLine, info.startByte);

		const parent = stack[stack.length - 1];
		const qualifiedName = parent === undefined ? name : `${parent.decl.qualifiedName}.${name}`;
		const decl: Decl = {
			kind: "heading",
			name,
			qualifiedName,
			startLine: info.line,
			endLine: info.line,
			startByte: info.startByte,
			endByte: info.endByte,
			signatureEndByte: info.endByte,
			bodyStartByte: info.nextByte,
			bodyEndByte: info.nextByte,
			visibility: "public",
			exported: true,
			children: [],
		};

		if (parent === undefined) roots.push(decl);
		else parent.decl.children.push(decl);
		stack.push({ decl, depth });
	}

	const last = lines[lines.length - 1];
	const eofLine = last === undefined ? 1 : last.line;
	const eofByte = last === undefined ? 0 : last.nextByte;
	closeOpen(stack, 1, eofLine, eofByte);

	return { decls: roots, imports: [] };
}
