import type { Node } from "web-tree-sitter";
import type { CallSite, Decl } from "../ir.ts";

export type DocSpan = {
	docStartOffset: number;
	docEndOffset: number;
};

export function startLine(node: Node): number {
	return node.startPosition.row + 1;
}

export function endLine(node: Node): number {
	const { row, column } = node.endPosition;
	if (column === 0 && row > node.startPosition.row) return row;
	return row + 1;
}

function newlineCount(source: string, from: number, to: number): number {
	let count = 0;
	const end = Math.min(to, source.length);
	for (let i = Math.max(0, from); i < end; i += 1) {
		if (source.charCodeAt(i) === 10) count += 1;
	}
	return count;
}

function isCommentType(type: string, commentTypes: readonly string[]): boolean {
	return commentTypes.includes(type);
}

/**
 * Contiguous leading comment siblings; ≤1 blank line between comments and before decl.
 * `skipTypes` walks back through those sibling types first (e.g. TS decorators, Rust attributes).
 * `commentTypes` defaults to tree-sitter `comment`; grammars that split line/block must pass their own.
 */
export function docSpanBefore(
	node: Node,
	source: string,
	skipTypes: readonly string[] = [],
	// Most grammars use `comment`; rust/java/kotlin pass their own line/block kinds.
	commentTypes: readonly string[] = ["comment"],
): DocSpan | undefined {
	let cursor = node.previousSibling;
	while (cursor !== null && skipTypes.includes(cursor.type)) {
		cursor = cursor.previousSibling;
	}
	if (cursor === null || !isCommentType(cursor.type, commentTypes)) return undefined;
	if (newlineCount(source, cursor.endIndex, node.startIndex) > 2) return undefined;

	const docEndOffset = cursor.endIndex;
	let docStartOffset = cursor.startIndex;
	let gapRightStart = cursor.startIndex;

	cursor = cursor.previousSibling;
	while (cursor !== null && isCommentType(cursor.type, commentTypes)) {
		if (newlineCount(source, cursor.endIndex, gapRightStart) > 2) break;
		docStartOffset = cursor.startIndex;
		gapRightStart = cursor.startIndex;
		cursor = cursor.previousSibling;
	}
	return { docStartOffset, docEndOffset };
}

/**
 * Trailing comment children of a preceding container (Kotlin package_header / import_list quirk).
 * Same blank-line rule as sibling docs.
 */
export function docSpanTrailingChild(
	container: Node,
	before: Node,
	source: string,
	commentTypes: readonly string[],
): DocSpan | undefined {
	const named = container.namedChildren;
	if (named.length === 0) return undefined;
	const lastIndex = named.length - 1;
	const lastComment = named[lastIndex];
	if (lastComment === undefined || !isCommentType(lastComment.type, commentTypes)) return undefined;
	if (newlineCount(source, lastComment.endIndex, before.startIndex) > 2) return undefined;

	let firstIndex = lastIndex;
	while (firstIndex - 1 >= 0) {
		const prev = named[firstIndex - 1];
		const current = named[firstIndex];
		if (prev === undefined || current === undefined || !isCommentType(prev.type, commentTypes)) break;
		if (newlineCount(source, prev.endIndex, current.startIndex) > 2) break;
		firstIndex -= 1;
	}
	const first = named[firstIndex];
	if (first === undefined) return undefined;
	return { docStartOffset: first.startIndex, docEndOffset: lastComment.endIndex };
}

/** Expand decl start left through contiguous previous siblings of the given types (e.g. Rust attributes). */
export function spanThroughPrevious(node: Node, types: readonly string[]): { startOffset: number; startLine: number } {
	let startOffset = node.startIndex;
	let line = startLine(node);
	let cursor = node.previousSibling;
	while (cursor !== null && types.includes(cursor.type)) {
		startOffset = cursor.startIndex;
		line = startLine(cursor);
		cursor = cursor.previousSibling;
	}
	return { startOffset, startLine: line };
}

export function applyDoc(decl: Decl, doc: DocSpan | undefined): Decl {
	if (doc === undefined) return decl;
	return {
		...decl,
		docStartOffset: doc.docStartOffset,
		docEndOffset: doc.docEndOffset,
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

export type DeclDraft = Omit<Decl, "signatureEndOffset" | "children" | "calls" | "bases"> &
	Partial<Pick<Decl, "signatureEndOffset" | "bodyStartOffset" | "bodyEndOffset" | "children" | "calls" | "bases">>;

export function finishDecl(partial: DeclDraft, body: Node | null): Decl {
	const calls = partial.calls ?? [];
	const bases = partial.bases ?? [];
	if (body === null) {
		return {
			...partial,
			signatureEndOffset: partial.signatureEndOffset ?? partial.endOffset,
			children: partial.children ?? [],
			calls,
			bases,
		};
	}
	return {
		...partial,
		signatureEndOffset: body.startIndex,
		bodyStartOffset: body.startIndex,
		bodyEndOffset: body.endIndex,
		children: partial.children ?? [],
		calls,
		bases,
	};
}

/**
 * Walk a body for call extraction. Skips nested scope roots (`isNestedScope`)
 * so nested callables own their own sites.
 */
export function walkBodyNodes(body: Node, isNestedScope: (node: Node) => boolean, visit: (node: Node) => void): void {
	const go = (node: Node, isRoot: boolean): void => {
		if (!isRoot && isNestedScope(node)) return;
		visit(node);
		for (const child of node.namedChildren) go(child, false);
	};
	go(body, true);
}

export function callSite(
	name: string,
	line: number,
	startOffset: number,
	endOffset: number,
	kind: CallSite["kind"],
	receiver = "",
): CallSite | undefined {
	if (name.length === 0) return undefined;
	return { name, receiver, line, startOffset, endOffset, kind };
}

const CALLABLE_KINDS = new Set<Decl["kind"]>(["function", "method", "constructor"]);
const TYPE_LIKE_KINDS = new Set<Decl["kind"]>(["class", "interface", "enum", "struct", "object"]);

export type LeafBuilder = (
	node: Node,
	owner: string,
	kind: Decl["kind"],
	name: string,
	visibility: Decl["visibility"],
	body: Node | null,
	children: Decl[],
	doc: DocSpan | undefined,
) => Decl | undefined;

/**
 * Builds one leaf decl per grammar adapter: calls come from callable bodies,
 * bases from type-like heritage, and the span closes on the signature when the
 * node has no body.
 */
export function createLeafBuilder(
	extractCalls: (body: Node | null) => CallSite[],
	heritageBases: (node: Node) => string[],
): LeafBuilder {
	return (node, owner, kind, name, visibility, body, children, doc) => {
		if (name.length === 0) return undefined;
		const decl = finishDecl(
			{
				kind,
				name,
				qualifiedName: qualify(owner, name),
				startLine: startLine(node),
				endLine: endLine(node),
				startOffset: node.startIndex,
				endOffset: node.endIndex,
				visibility,
				exported: visibility === "public",
				children,
				calls: CALLABLE_KINDS.has(kind) ? extractCalls(body) : [],
				bases: TYPE_LIKE_KINDS.has(kind) ? heritageBases(node) : [],
			},
			body,
		);
		if (body === null) decl.signatureEndOffset = node.endIndex;
		return applyDoc(decl, doc);
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
				startOffset: node.startIndex,
				endOffset: node.endIndex,
				visibility,
				exported,
				children,
			},
			body,
		),
		doc,
	);
}
