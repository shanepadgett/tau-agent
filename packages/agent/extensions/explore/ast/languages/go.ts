import type { Node, Tree } from "web-tree-sitter";
import type { ExtractResult, GrammarAdapter, LanguageCapabilities } from "../adapter.ts";
import { resolveGoFileDep } from "./go-file-deps.ts";
import type { CallSite, Decl, ImportRef, Visibility } from "../ir.ts";
import {
	applyDoc,
	callSite,
	docSpanBefore,
	endLine,
	field,
	finishDecl,
	nameText,
	qualify,
	startLine,
	unquote,
	walkBodyNodes,
	type DocSpan,
} from "./tree.ts";

const CAPABILITIES: LanguageCapabilities = {
	shape: true,
	search: true,
	fileDeps: true,
	callEdges: true,
	packageSurface: false,
};

const IMPORT_NOISE = new Set([
	"break",
	"case",
	"chan",
	"const",
	"continue",
	"default",
	"defer",
	"else",
	"fallthrough",
	"for",
	"func",
	"go",
	"goto",
	"if",
	"import",
	"interface",
	"map",
	"package",
	"range",
	"return",
	"select",
	"struct",
	"switch",
	"type",
	"var",
	"iota",
	"true",
	"false",
	"nil",
	"error",
	"int",
	"int32",
	"int64",
	"uint",
	"byte",
	"rune",
	"string",
	"bool",
	"float64",
	"any",
]);

const EXTENSIONS = [".go"] as const;

// Node-type constants — owned by this adapter.
const FUNCTION_DECLARATION = "function_declaration";
const METHOD_DECLARATION = "method_declaration";
const TYPE_DECLARATION = "type_declaration";
const TYPE_SPEC = "type_spec";
const TYPE_ALIAS = "type_alias";
const CONST_DECLARATION = "const_declaration";
const CONST_SPEC = "const_spec";
const VAR_DECLARATION = "var_declaration";
const VAR_SPEC = "var_spec";
const VAR_SPEC_LIST = "var_spec_list";
const IMPORT_DECLARATION = "import_declaration";
const IMPORT_SPEC = "import_spec";
const IMPORT_SPEC_LIST = "import_spec_list";
const STRUCT_TYPE = "struct_type";
const INTERFACE_TYPE = "interface_type";
const FIELD_DECLARATION_LIST = "field_declaration_list";
const FIELD_DECLARATION = "field_declaration";
const METHOD_ELEM = "method_elem";
const CALL_EXPRESSION = "call_expression";
const COMPOSITE_LITERAL = "composite_literal";
const SELECTOR_EXPRESSION = "selector_expression";
const IDENTIFIER = "identifier";
const TYPE_IDENTIFIER = "type_identifier";
const BLOCK = "block";

const NESTED_SCOPE = new Set([FUNCTION_DECLARATION, METHOD_DECLARATION]);

function extractCalls(body: Node | null): CallSite[] {
	if (body === null) return [];
	const out: CallSite[] = [];
	walkBodyNodes(
		body,
		(node) => NESTED_SCOPE.has(node.type),
		(node) => {
			if (node.type === CALL_EXPRESSION) {
				const fn = field(node, "function");
				if (fn === null) return;
				let name = "";
				let receiver = "";
				let leaf: Node | null = null;
				if (fn.type === IDENTIFIER) {
					name = fn.text;
					leaf = fn;
				} else if (fn.type === SELECTOR_EXPRESSION) {
					const fld = field(fn, "field");
					const op = field(fn, "operand");
					if (fld !== null) {
						name = fld.text;
						leaf = fld;
					}
					receiver = op === null ? "" : op.text;
				}
				if (leaf === null || name.length === 0) return;
				const site = callSite(name, startLine(leaf), leaf.startIndex, leaf.endIndex, "call", receiver);
				if (site !== undefined) out.push(site);
				return;
			}
			if (node.type === COMPOSITE_LITERAL) {
				const typeNode = field(node, "type");
				if (typeNode === null) return;
				const leaf =
					typeNode.type === TYPE_IDENTIFIER || typeNode.type === IDENTIFIER
						? typeNode
						: typeNode.namedChildren.find((c) => c.type === TYPE_IDENTIFIER || c.type === IDENTIFIER);
				if (leaf === undefined || leaf === null) return;
				const site = callSite(leaf.text, startLine(leaf), leaf.startIndex, leaf.endIndex, "construct");
				if (site !== undefined) out.push(site);
			}
		},
	);
	return out;
}

function embeddedBases(list: Node | null): string[] {
	if (list === null) return [];
	const bases: string[] = [];
	for (const node of list.namedChildren) {
		if (node.type !== FIELD_DECLARATION) continue;
		if (node.childrenForFieldName("name").length > 0) continue;
		const typeNode = field(node, "type");
		if (typeNode === null) continue;
		const text = typeNode.text.replace(/^\*/, "");
		const bare = text.includes(".") ? (text.split(".").pop() ?? text) : text;
		if (bare.length > 0) bases.push(bare);
	}
	return bases;
}
const POINTER_TYPE = "pointer_type";
const PARAMETER_DECLARATION = "parameter_declaration";

/** Go exported = first rune uppercase (unicode letter). */
function goExported(name: string): boolean {
	if (name.length === 0) return false;
	const cp = name.codePointAt(0);
	if (cp === undefined) return false;
	const ch = String.fromCodePoint(cp);
	return ch.toUpperCase() === ch && ch.toLowerCase() !== ch;
}

function visibilityFor(name: string): Visibility {
	return goExported(name) ? "public" : "private";
}

function receiverTypeName(receiver: Node): string {
	for (const param of receiver.namedChildren) {
		if (param.type !== PARAMETER_DECLARATION) continue;
		const typeNode = field(param, "type");
		if (typeNode === null) continue;
		if (typeNode.type === POINTER_TYPE) {
			const inner = typeNode.namedChildren[0];
			if (inner !== undefined) return inner.text;
		}
		return typeNode.text;
	}
	return "";
}

function braceOpen(node: Node): Node | undefined {
	for (const child of node.children) {
		if (child.type === "{") return child;
	}
	return undefined;
}

function typeSpecKind(typeNode: Node): Decl["kind"] {
	if (typeNode.type === STRUCT_TYPE) return "struct";
	if (typeNode.type === INTERFACE_TYPE) return "interface";
	return "type";
}

function leafMember(
	node: Node,
	owner: string,
	kind: Decl["kind"],
	name: string,
	endNode: Node = node,
): Decl | undefined {
	if (name.length === 0) return undefined;
	return {
		kind,
		name,
		qualifiedName: qualify(owner, name),
		startLine: startLine(node),
		endLine: endLine(endNode),
		startOffset: node.startIndex,
		endOffset: endNode.endIndex,
		signatureEndOffset: endNode.endIndex,
		visibility: visibilityFor(name),
		exported: goExported(name),
		children: [],
		calls: [],
		bases: [],
	};
}

function structFields(list: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	for (const node of list.namedChildren) {
		if (node.type !== FIELD_DECLARATION) continue;
		const nameNodes = node.childrenForFieldName("name");
		if (nameNodes.length === 0) {
			// Embedded field — name is the type identifier text.
			const typeNode = field(node, "type");
			const name = typeNode === null ? "" : typeNode.text.replace(/^\*/, "");
			const decl = leafMember(node, owner, "field", name);
			if (decl !== undefined) out.push(decl);
			continue;
		}
		for (const nameNode of nameNodes) {
			const decl = leafMember(nameNode, owner, "field", nameNode.text, node);
			if (decl !== undefined) out.push(decl);
		}
	}
	return out;
}

function interfaceMethods(iface: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	for (const node of iface.namedChildren) {
		if (node.type !== METHOD_ELEM) continue;
		const decl = leafMember(node, owner, "method", nameText(field(node, "name")));
		if (decl !== undefined) out.push(decl);
	}
	return out;
}

function declsFromTypeSpec(spec: Node, span: Node, doc: DocSpan | undefined): Decl[] {
	const name = nameText(field(spec, "name"));
	if (name.length === 0) return [];
	const typeNode = field(spec, "type");
	if (typeNode === null) return [];

	const kind = typeSpecKind(typeNode);
	let children: Decl[] = [];
	let body: Node | null = null;

	if (typeNode.type === STRUCT_TYPE) {
		const list = typeNode.namedChildren.find((child) => child.type === FIELD_DECLARATION_LIST);
		if (list !== undefined) {
			body = list;
			children = structFields(list, name);
		}
	} else if (typeNode.type === INTERFACE_TYPE) {
		const open = braceOpen(typeNode);
		if (open !== undefined) {
			const decl = applyDoc(
				{
					kind,
					name,
					qualifiedName: name,
					startLine: startLine(span),
					endLine: endLine(span),
					startOffset: span.startIndex,
					endOffset: span.endIndex,
					signatureEndOffset: open.startIndex,
					bodyStartOffset: open.startIndex,
					bodyEndOffset: typeNode.endIndex,
					visibility: visibilityFor(name),
					exported: goExported(name),
					children: interfaceMethods(typeNode, name),
					calls: [],
					bases: [],
				},
				doc,
			);
			return [decl];
		}
	}

	const decl = finishDecl(
		{
			kind,
			name,
			qualifiedName: name,
			startLine: startLine(span),
			endLine: endLine(span),
			startOffset: span.startIndex,
			endOffset: span.endIndex,
			visibility: visibilityFor(name),
			exported: goExported(name),
			children,
			bases: typeNode.type === STRUCT_TYPE ? embeddedBases(body) : [],
		},
		body,
	);
	return [applyDoc(decl, doc)];
}

function declsFromTypeAlias(alias: Node, span: Node, doc: DocSpan | undefined): Decl[] {
	const name = nameText(field(alias, "name"));
	if (name.length === 0) return [];
	const decl = finishDecl(
		{
			kind: "typeAlias",
			name,
			qualifiedName: name,
			startLine: startLine(span),
			endLine: endLine(span),
			startOffset: span.startIndex,
			endOffset: span.endIndex,
			visibility: visibilityFor(name),
			exported: goExported(name),
		},
		null,
	);
	return [applyDoc(decl, doc)];
}

function declsFromTypeDeclaration(node: Node, source: string): Decl[] {
	const doc = docSpanBefore(node, source);
	const entries: Node[] = [];
	for (const child of node.namedChildren) {
		if (child.type === TYPE_SPEC || child.type === TYPE_ALIAS) entries.push(child);
	}
	const single = entries.length === 1;
	const out: Decl[] = [];
	let first = true;
	for (const child of entries) {
		const span = single ? node : child;
		const attached = first ? doc : undefined;
		first = false;
		if (child.type === TYPE_SPEC) out.push(...declsFromTypeSpec(child, span, attached));
		else out.push(...declsFromTypeAlias(child, span, attached));
	}
	return out;
}

function specNames(spec: Node): Node[] {
	return spec.childrenForFieldName("name");
}

function declsFromConstOrVar(node: Node, kind: "constant" | "variable", source: string): Decl[] {
	const doc = docSpanBefore(node, source);
	const specs: Node[] = [];
	for (const child of node.namedChildren) {
		if (child.type === CONST_SPEC || child.type === VAR_SPEC) specs.push(child);
		if (child.type === VAR_SPEC_LIST) {
			for (const inner of child.namedChildren) {
				if (inner.type === VAR_SPEC) specs.push(inner);
			}
		}
	}

	const totalNames = specs.reduce((n, spec) => n + specNames(spec).length, 0);
	const single = totalNames === 1;
	const out: Decl[] = [];
	let docUsed = false;
	for (const spec of specs) {
		for (const nameNode of specNames(spec)) {
			const name = nameNode.text;
			const spanStart = single ? node : nameNode;
			const spanEnd = single ? node : spec;
			const decl = finishDecl(
				{
					kind,
					name,
					qualifiedName: name,
					startLine: startLine(spanStart),
					endLine: endLine(spanEnd),
					startOffset: spanStart.startIndex,
					endOffset: spanEnd.endIndex,
					visibility: visibilityFor(name),
					exported: goExported(name),
				},
				null,
			);
			if (!docUsed) {
				out.push(applyDoc(decl, doc));
				docUsed = true;
			} else {
				out.push(decl);
			}
		}
	}
	return out;
}

function declsFromFunction(node: Node, source: string): Decl[] {
	const doc = docSpanBefore(node, source);
	const name = nameText(field(node, "name"));
	if (name.length === 0) return [];
	const body = field(node, "body");
	const bodyNode = body !== null && body.type === BLOCK ? body : null;
	const decl = finishDecl(
		{
			kind: "function",
			name,
			qualifiedName: name,
			startLine: startLine(node),
			endLine: endLine(node),
			startOffset: node.startIndex,
			endOffset: node.endIndex,
			visibility: visibilityFor(name),
			exported: goExported(name),
			calls: extractCalls(bodyNode),
		},
		bodyNode,
	);
	return [applyDoc(decl, doc)];
}

function declsFromMethod(node: Node, source: string): Decl[] {
	const doc = docSpanBefore(node, source);
	const name = nameText(field(node, "name"));
	if (name.length === 0) return [];
	const receiver = field(node, "receiver");
	const recvName = receiver === null ? "" : receiverTypeName(receiver);
	const qualifiedName = recvName.length === 0 ? name : `${recvName}.${name}`;
	const body = field(node, "body");
	const bodyNode = body !== null && body.type === BLOCK ? body : null;
	const decl = finishDecl(
		{
			kind: "method",
			name,
			qualifiedName,
			startLine: startLine(node),
			endLine: endLine(node),
			startOffset: node.startIndex,
			endOffset: node.endIndex,
			visibility: visibilityFor(name),
			exported: goExported(name),
			calls: extractCalls(bodyNode),
		},
		bodyNode,
	);
	return [applyDoc(decl, doc)];
}

function collectImports(root: Node): ImportRef[] {
	const imports: ImportRef[] = [];
	for (const node of root.namedChildren) {
		if (node.type !== IMPORT_DECLARATION) continue;
		// Per-spec specifier for file-graph; statement bytes cover the whole declaration.
		const specs: Node[] = [];
		for (const child of node.namedChildren) {
			if (child.type === IMPORT_SPEC) specs.push(child);
			if (child.type === IMPORT_SPEC_LIST) {
				for (const inner of child.namedChildren) {
					if (inner.type === IMPORT_SPEC) specs.push(inner);
				}
			}
		}
		for (const spec of specs) {
			const pathNode = field(spec, "path");
			if (pathNode === null) continue;
			imports.push({
				specifier: unquote(pathNode.text),
				startLine: startLine(spec),
				startOffset: node.startIndex,
				endOffset: node.endIndex,
				bindings: [],
			});
		}
	}
	return imports;
}

function extractFromNode(node: Node, source: string, decls: Decl[]): void {
	if (node.isError || node.type === "ERROR") {
		for (const child of node.children) {
			if (child.isNamed || child.isError) extractFromNode(child, source, decls);
		}
		return;
	}
	switch (node.type) {
		case FUNCTION_DECLARATION:
			decls.push(...declsFromFunction(node, source));
			break;
		case METHOD_DECLARATION:
			decls.push(...declsFromMethod(node, source));
			break;
		case TYPE_DECLARATION:
			decls.push(...declsFromTypeDeclaration(node, source));
			break;
		case CONST_DECLARATION:
			decls.push(...declsFromConstOrVar(node, "constant", source));
			break;
		case VAR_DECLARATION:
			decls.push(...declsFromConstOrVar(node, "variable", source));
			break;
		default:
			break;
	}
}

function extractGo(tree: Tree, source: string): ExtractResult {
	const root = tree.rootNode;
	const decls: Decl[] = [];
	for (const node of root.children) {
		if (node.isNamed || node.isError) extractFromNode(node, source, decls);
	}
	return { decls, imports: collectImports(root) };
}

/** Bare `pkg.Call($A)` parses as type_conversion in Go; wrap as a statement call. */
const PATTERN_CONTEXTS = [
	{ context: "func f() {\n$PATTERN\n}", selector: "call_expression" },
	{ context: "_ = $PATTERN", selector: "call_expression" },
] as const;

export function goAdapter(): GrammarAdapter {
	return {
		mode: "grammar",
		id: "go",
		extensions: EXTENSIONS,
		capabilities: CAPABILITIES,
		importNoiseIdentifiers: IMPORT_NOISE,
		extract: extractGo,
		resolveFileDep: resolveGoFileDep,
		patternContexts: PATTERN_CONTEXTS,
	};
}
