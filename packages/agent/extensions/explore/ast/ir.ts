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
	/** UTF-8 byte offset, inclusive. */
	startByte: number;
	/** UTF-8 byte offset, exclusive (tree-sitter endIndex convention). */
	endByte: number;
	/** Decl start → body open; signature = source UTF-8 slice [startByte, signatureEndByte). */
	signatureEndByte: number;
	/** Absent when no body. */
	bodyStartByte?: number;
	bodyEndByte?: number;
	/** Attached doc comment span. */
	docStartByte?: number;
	docEndByte?: number;
	visibility: Visibility;
	exported: boolean;
	children: Decl[];
};

export type ImportRef = {
	specifier: string;
	startLine: number;
	/** UTF-8 byte offset of the full import statement (inclusive). */
	startByte: number;
	/** UTF-8 byte offset of the full import statement (exclusive). */
	endByte: number;
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
