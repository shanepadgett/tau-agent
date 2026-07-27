/** Shared declaration-kind vocabulary. Extend only for a real new kind. */
export type DeclKind =
	| "module"
	| "namespace"
	| "package"
	| "class"
	| "method"
	| "property"
	| "field"
	| "constructor"
	| "enum"
	| "interface"
	| "typeAlias"
	| "function"
	| "variable"
	| "constant"
	| "object"
	| "enumMember"
	| "struct"
	| "event"
	| "operator"
	| "typeParameter"
	| "heading";

export type Visibility = "public" | "private" | "protected" | "internal";

export type Decl = {
	kind: DeclKind;
	name: string;
	/** Dotted owner.member path. */
	qualifiedName: string;
	/** 1-indexed, inclusive. */
	startLine: number;
	/** 1-indexed, inclusive. */
	endLine: number;
	/** UTF-16 code-unit offset into the decoded source string, inclusive (tree-sitter startIndex convention). */
	startOffset: number;
	/** UTF-16 code-unit offset into the decoded source string, exclusive (tree-sitter endIndex convention). */
	endOffset: number;
	/** Decl start → body open; signature = source.slice(startOffset, signatureEndOffset). */
	signatureEndOffset: number;
	/** Absent when no body. */
	bodyStartOffset?: number;
	bodyEndOffset?: number;
	/** Attached doc comment span. */
	docStartOffset?: number;
	docEndOffset?: number;
	visibility: Visibility;
	exported: boolean;
	children: Decl[];
};

export type ImportRef = {
	specifier: string;
	startLine: number;
	/** UTF-16 offset of the full import statement (inclusive). */
	startOffset: number;
	/** UTF-16 offset of the full import statement (exclusive). */
	endOffset: number;
};

export type FileIr = {
	/** Absolute resolved path. */
	path: string;
	/** sha256 hex of file bytes. */
	contentHash: string;
	languageId: string;
	lineCount: number;
	decls: Decl[];
	imports: ImportRef[];
	/** True when the parse tree contained ERROR/MISSING nodes. */
	parseDegraded: boolean;
};
