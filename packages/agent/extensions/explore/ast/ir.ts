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
	| "type"
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

export function isTypeLike(kind: DeclKind): boolean {
	return (
		kind === "class" ||
		kind === "interface" ||
		kind === "struct" ||
		kind === "enum" ||
		kind === "type" ||
		kind === "typeAlias" ||
		kind === "object" ||
		kind === "namespace" ||
		kind === "module" ||
		kind === "package"
	);
}

export function isCallableLike(kind: DeclKind): boolean {
	return kind === "function" || kind === "method" || kind === "constructor" || kind === "operator";
}

export type Visibility = "public" | "private" | "protected" | "internal";

/** Syntactic call/construct site inside a callable body (adapter-owned extraction). */
export type CallKind = "call" | "construct" | "macro" | "super";

export type CallSite = {
	/** Bare callee / type name as written. */
	name: string;
	/** Receiver text when method-like (`obj` in `obj.foo()`); empty when free. */
	receiver: string;
	/** 1-indexed. */
	line: number;
	/** UTF-16 offsets of the name leaf (decision 12). */
	startOffset: number;
	endOffset: number;
	kind: CallKind;
};

/** One local name introduced by an import statement. */
export type ImportBinding = {
	/** Name visible in this file. */
	local: string;
	/** Remote name when distinct from local (`Foo as Bar` → imported Foo, local Bar). */
	imported: string;
};

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
	/** Initializer/body spans replaced with compact markers when a signature cannot be one contiguous source slice. */
	signatureOmissions?: Array<{
		startOffset: number;
		endOffset: number;
		replacement: string;
	}>;
	/** Absent when no body. */
	bodyStartOffset?: number;
	bodyEndOffset?: number;
	/** Attached doc comment span. */
	docStartOffset?: number;
	docEndOffset?: number;
	visibility: Visibility;
	exported: boolean;
	children: Decl[];
	/**
	 * Direct call/construct sites textually inside this decl's body.
	 * Nested callables own their own lists — do not hoist.
	 * Empty for non-callables and body-less decls.
	 */
	calls: CallSite[];
	/**
	 * Heritage / supertype / trait names on this type-like decl (bare identifiers).
	 * Empty when not a type or no heritage.
	 */
	bases: string[];
};

export type ImportRef = {
	specifier: string;
	startLine: number;
	/** UTF-16 offset of the full import statement (inclusive). */
	startOffset: number;
	/** UTF-16 offset of the full import statement (exclusive). */
	endOffset: number;
	/** Local names this import binds. Empty when the statement binds nothing useful (side-effect import). */
	bindings: ImportBinding[];
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
