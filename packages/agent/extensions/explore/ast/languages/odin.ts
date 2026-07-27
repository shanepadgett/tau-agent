import type { Node, Tree } from "web-tree-sitter";
import type { ExtractResult, GrammarAdapter, LanguageCapabilities } from "../adapter.ts";
import type { Decl, ImportRef, Visibility } from "../ir.ts";
import { applyDoc, docSpanBefore, endLine, finishDecl, qualify, startLine, unquote, type DocSpan } from "./tree.ts";

const CAPABILITIES: LanguageCapabilities = {
	shape: true,
	search: true,
	fileDeps: false,
	callEdges: true,
	packageSurface: false,
};

const EXTENSIONS = [".odin"] as const;

/**
 * Node kinds from tree-sitter-odin v1.3.0 node-types + locals.scm definitions:
 *   procedure_declaration, overloaded_procedure_declaration → function
 *   struct_declaration / union_declaration / bit_field_declaration → struct (union/bit_field closest kind)
 *   enum_declaration → enum
 *   const_declaration / const_type_declaration → constant
 *   variable_declaration (`:=`) → variable, or function when value is `procedure`
 *   var_declaration (`:`) → variable
 *   field → struct field
 *   foreign_block → walk nested package-level decls
 * Package-level only (plan). Nested procs inside function bodies stay out.
 */
const PROCEDURE_DECLARATION = "procedure_declaration";
const OVERLOADED_PROCEDURE_DECLARATION = "overloaded_procedure_declaration";
const STRUCT_DECLARATION = "struct_declaration";
const ENUM_DECLARATION = "enum_declaration";
const UNION_DECLARATION = "union_declaration";
const BIT_FIELD_DECLARATION = "bit_field_declaration";
const CONST_DECLARATION = "const_declaration";
const CONST_TYPE_DECLARATION = "const_type_declaration";
const VAR_DECLARATION = "var_declaration";
const VARIABLE_DECLARATION = "variable_declaration";
const FOREIGN_BLOCK = "foreign_block";
const IMPORT_DECLARATION = "import_declaration";
const ATTRIBUTES = "attributes";
const ATTRIBUTE = "attribute";
const IDENTIFIER = "identifier";
const PROCEDURE = "procedure";
const FIELD = "field";
const BLOCK = "block";

function odinDoc(node: Node, source: string): DocSpan | undefined {
	return docSpanBefore(node, source);
}

function hasPrivateAttribute(node: Node): boolean {
	const attrs = node.namedChildren.find((child) => child.type === ATTRIBUTES);
	if (attrs === undefined) return false;
	for (const attr of attrs.namedChildren) {
		if (attr.type !== ATTRIBUTE) continue;
		for (const child of attr.namedChildren) {
			if (child.type === IDENTIFIER && child.text === "private") return true;
		}
	}
	return false;
}

function visibilityOf(node: Node): Visibility {
	return hasPrivateAttribute(node) ? "private" : "public";
}

/** First non-attribute identifier child — name position for all odin decls in this grammar. */
function firstIdentifier(node: Node): string {
	for (const child of node.namedChildren) {
		if (child.type === ATTRIBUTES) continue;
		if (child.type === IDENTIFIER) return child.text;
	}
	return "";
}

function procedureBody(node: Node): Node | null {
	const proc = node.namedChildren.find((child) => child.type === PROCEDURE);
	if (proc === undefined) return null;
	// `---` foreign stubs use uninitialized, not block.
	return proc.namedChildren.find((child) => child.type === BLOCK) ?? null;
}

function leaf(
	node: Node,
	owner: string,
	kind: Decl["kind"],
	name: string,
	visibility: Visibility,
	body: Node | null,
	children: Decl[],
	doc: DocSpan | undefined,
): Decl | undefined {
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
		},
		body,
	);
	if (body === null) decl.signatureEndOffset = node.endIndex;
	return applyDoc(decl, doc);
}

/** struct_declaration children of type `field` (not `struct_field` — that is composite-literal elements). */
function structFields(node: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	for (const child of node.namedChildren) {
		if (child.type !== FIELD) continue;
		const names: string[] = [];
		for (const part of child.namedChildren) {
			if (part.type === IDENTIFIER) names.push(part.text);
			if (part.type === "type") break;
		}
		for (const name of names) {
			// `using _: T` embedding — skip blank identifier.
			if (name === "_") continue;
			const decl = leaf(child, owner, "field", name, "public", null, [], undefined);
			if (decl !== undefined) out.push(decl);
		}
	}
	return out;
}

function enumMembers(node: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	let seenName = false;
	for (const child of node.namedChildren) {
		if (child.type !== IDENTIFIER) continue;
		if (!seenName) {
			seenName = true;
			continue;
		}
		const decl = leaf(child, owner, "enumMember", child.text, "public", null, [], undefined);
		if (decl !== undefined) out.push(decl);
	}
	return out;
}

/**
 * bit_field_declaration flattens members as identifier/type/number triples after the backing type.
 * Shape: Name :: bit_field Backing { field: T | bits, ... }
 */
function bitFieldMembers(node: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	let seenName = false;
	let seenBackingType = false;
	for (const child of node.namedChildren) {
		if (child.type === ATTRIBUTES) continue;
		if (!seenName && child.type === IDENTIFIER) {
			seenName = true;
			continue;
		}
		if (seenName && !seenBackingType && child.type === "type") {
			seenBackingType = true;
			continue;
		}
		if (!seenBackingType) continue;
		if (child.type === IDENTIFIER) {
			const decl = leaf(child, owner, "field", child.text, "public", null, [], undefined);
			if (decl !== undefined) out.push(decl);
		}
	}
	return out;
}

function cutSignatureBefore(node: Node, firstChild: Node | undefined, decl: Decl): void {
	if (firstChild === undefined) return;
	decl.signatureEndOffset = firstChild.startIndex;
	decl.bodyStartOffset = firstChild.startIndex;
	decl.bodyEndOffset = node.endIndex;
}

function declsFromNode(node: Node, owner: string, source: string): Decl[] {
	if (node.isError || node.type === "ERROR") {
		const out: Decl[] = [];
		for (const child of node.children) {
			if (child.isNamed || child.isError) out.push(...declsFromNode(child, owner, source));
		}
		return out;
	}

	const doc = odinDoc(node, source);
	const visibility = visibilityOf(node);

	switch (node.type) {
		case PROCEDURE_DECLARATION:
		case OVERLOADED_PROCEDURE_DECLARATION: {
			const name = firstIdentifier(node);
			const body = node.type === PROCEDURE_DECLARATION ? procedureBody(node) : null;
			const decl = leaf(node, owner, "function", name, visibility, body, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case STRUCT_DECLARATION: {
			const name = firstIdentifier(node);
			const qn = qualify(owner, name);
			const children = structFields(node, qn);
			const firstField = node.namedChildren.find((child) => child.type === FIELD);
			const decl = leaf(node, owner, "struct", name, visibility, null, children, doc);
			if (decl !== undefined) cutSignatureBefore(node, firstField, decl);
			return decl === undefined ? [] : [decl];
		}
		case UNION_DECLARATION: {
			// locals.scm: union → type; shared IR uses struct as closest kind.
			const name = firstIdentifier(node);
			const decl = leaf(node, owner, "struct", name, visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case BIT_FIELD_DECLARATION: {
			// locals.scm: bit_field → type; shared IR uses struct.
			const name = firstIdentifier(node);
			const qn = qualify(owner, name);
			const children = bitFieldMembers(node, qn);
			const decl = leaf(node, owner, "struct", name, visibility, null, children, doc);
			// Signature through backing type: first member identifier after backing `type`.
			const firstMember = children[0];
			if (decl !== undefined && firstMember !== undefined) {
				decl.signatureEndOffset = firstMember.startOffset;
				decl.bodyStartOffset = firstMember.startOffset;
				decl.bodyEndOffset = node.endIndex;
			}
			return decl === undefined ? [] : [decl];
		}
		case ENUM_DECLARATION: {
			const name = firstIdentifier(node);
			const qn = qualify(owner, name);
			const children = enumMembers(node, qn);
			const decl = leaf(node, owner, "enum", name, visibility, null, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case CONST_DECLARATION:
		case CONST_TYPE_DECLARATION: {
			// locals.scm: const_declaration → constant; const_type_declaration → type (value const with explicit type).
			const name = firstIdentifier(node);
			// `_ :: runtime` package aliases are not outline decls.
			if (name === "_") return [];
			const decl = leaf(node, owner, "constant", name, visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case VAR_DECLARATION: {
			// `name: Type` / `name: Type = value`
			const name = firstIdentifier(node);
			if (name === "_") return [];
			const decl = leaf(node, owner, "variable", name, visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case VARIABLE_DECLARATION: {
			// `name := value` — function when value is a procedure literal (locals.scm still marks var).
			const name = firstIdentifier(node);
			if (name === "_") return [];
			const proc = node.namedChildren.find((child) => child.type === PROCEDURE);
			if (proc !== undefined) {
				const body = proc.namedChildren.find((child) => child.type === BLOCK) ?? null;
				const decl = leaf(node, owner, "function", name, visibility, body, [], doc);
				return decl === undefined ? [] : [decl];
			}
			const decl = leaf(node, owner, "variable", name, visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case FOREIGN_BLOCK: {
			// Package-level foreign { ... } — extract nested decls at same owner.
			const block = node.namedChildren.find((child) => child.type === BLOCK);
			if (block === undefined) return [];
			const out: Decl[] = [];
			for (const child of block.namedChildren) {
				out.push(...declsFromNode(child, owner, source));
			}
			return out;
		}
		default:
			return [];
	}
}

function collectImports(root: Node): ImportRef[] {
	const imports: ImportRef[] = [];
	for (const node of root.namedChildren) {
		if (node.type !== IMPORT_DECLARATION) continue;
		const str = node.namedChildren.find((child) => child.type === "string");
		const specifier = str === undefined ? node.text : unquote(str.text);
		imports.push({
			specifier,
			startLine: startLine(node),
			startOffset: node.startIndex,
			endOffset: node.endIndex,
		});
	}
	return imports;
}

function extractOdin(tree: Tree, source: string): ExtractResult {
	const root = tree.rootNode;
	const decls: Decl[] = [];
	for (const node of root.children) {
		if (node.isNamed || node.isError) decls.push(...declsFromNode(node, "", source));
	}
	return { decls, imports: collectImports(root) };
}

export function odinAdapter(): GrammarAdapter {
	return {
		mode: "grammar",
		id: "odin",
		extensions: EXTENSIONS,
		capabilities: CAPABILITIES,
		extract: extractOdin,
	};
}
