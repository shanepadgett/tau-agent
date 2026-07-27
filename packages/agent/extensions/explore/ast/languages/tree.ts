// fallow-ignore-file unused-file,unused-export,unused-type -- wired by 06-outline-show
import type { Node } from "web-tree-sitter";
import type { Decl } from "../ir.ts";

export type DocSpan = {
	docStartByte: number;
	docEndByte: number;
};

export function startLine(node: Node): number {
	return node.startPosition.row + 1;
}

export function endLine(node: Node): number {
	const { row, column } = node.endPosition;
	if (column === 0 && row > node.startPosition.row) return row;
	return row + 1;
}

export function newlineCount(source: string, from: number, to: number): number {
	let count = 0;
	const end = Math.min(to, source.length);
	for (let i = Math.max(0, from); i < end; i += 1) {
		if (source.charCodeAt(i) === 10) count += 1;
	}
	return count;
}

/**
 * Contiguous leading comment siblings; ≤1 blank line between comments and before decl.
 * `skipTypes` walks back through those sibling types first (e.g. TS decorators).
 */
export function docSpanBefore(node: Node, source: string, skipTypes: readonly string[] = []): DocSpan | undefined {
	let cursor = node.previousSibling;
	while (cursor !== null && skipTypes.includes(cursor.type)) {
		cursor = cursor.previousSibling;
	}
	if (cursor === null || cursor.type !== "comment") return undefined;
	if (newlineCount(source, cursor.endIndex, node.startIndex) > 2) return undefined;

	const docEndByte = cursor.endIndex;
	let docStartByte = cursor.startIndex;
	let gapRightStart = cursor.startIndex;

	cursor = cursor.previousSibling;
	while (cursor !== null && cursor.type === "comment") {
		if (newlineCount(source, cursor.endIndex, gapRightStart) > 2) break;
		docStartByte = cursor.startIndex;
		gapRightStart = cursor.startIndex;
		cursor = cursor.previousSibling;
	}
	return { docStartByte, docEndByte };
}

export function applyDoc(decl: Decl, doc: DocSpan | undefined): Decl {
	if (doc === undefined) return decl;
	return {
		...decl,
		docStartByte: doc.docStartByte,
		docEndByte: doc.docEndByte,
	};
}

export function unquote(text: string): string {
	if (text.length < 2) return text;
	const a = text[0];
	const b = text[text.length - 1];
	if ((a === '"' || a === "'" || a === "`") && a === b) return text.slice(1, -1);
	return text;
}

export function field(node: Node, name: string): Node | null {
	return node.childForFieldName(name);
}

export function nameText(node: Node | null | undefined): string {
	if (node === null || node === undefined) return "";
	return node.text;
}

export function qualify(owner: string, name: string): string {
	return owner.length === 0 ? name : `${owner}.${name}`;
}

export type DeclDraft = Omit<Decl, "signatureEndByte" | "children"> &
	Partial<Pick<Decl, "signatureEndByte" | "bodyStartByte" | "bodyEndByte" | "children">>;

export function finishDecl(partial: DeclDraft, body: Node | null): Decl {
	if (body === null) {
		return {
			...partial,
			signatureEndByte: partial.signatureEndByte ?? partial.endByte,
			children: partial.children ?? [],
		};
	}
	return {
		...partial,
		signatureEndByte: body.startIndex,
		bodyStartByte: body.startIndex,
		bodyEndByte: body.endIndex,
		children: partial.children ?? [],
	};
}

/** Build a top-level-ish decl from a grammar node span + optional body. */
export function declFromNode(
	node: Node,
	owner: string,
	kind: Decl["kind"],
	name: string,
	exported: boolean,
	body: Node | null,
	children: Decl[],
	doc: DocSpan | undefined,
	visibility: Decl["visibility"] = "public",
): Decl | undefined {
	if (name.length === 0) return undefined;
	return applyDoc(
		finishDecl(
			{
				kind,
				name,
				qualifiedName: qualify(owner, name),
				startLine: startLine(node),
				endLine: endLine(node),
				startByte: node.startIndex,
				endByte: node.endIndex,
				visibility,
				exported,
				children,
			},
			body,
		),
		doc,
	);
}
