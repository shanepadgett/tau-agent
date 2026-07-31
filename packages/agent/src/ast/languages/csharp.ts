import type { Node, Tree } from "web-tree-sitter";
import type { ExtractResult, GrammarAdapter, LanguageCapabilities } from "../adapter.ts";
import { resolveCsharpFileDep } from "./csharp-file-deps.ts";
import type { CallSite, Decl, ImportRef, Visibility } from "../ir.ts";
import {
	callSite,
	type DocSpan,
	docSpanBefore,
	field,
	createLeafBuilder,
	nameText,
	qualify,
	startLine,
	walkBodyNodes,
} from "./tree.ts";

const CAPABILITIES: LanguageCapabilities = {
	shape: true,
	search: true,
	fileDeps: true,
	callEdges: true,
	packageSurface: false,
	structuralImplements: false,
};

const IMPORT_NOISE = new Set([
	"abstract",
	"as",
	"base",
	"bool",
	"break",
	"byte",
	"case",
	"catch",
	"char",
	"checked",
	"class",
	"const",
	"continue",
	"decimal",
	"default",
	"delegate",
	"do",
	"double",
	"else",
	"enum",
	"event",
	"explicit",
	"extern",
	"false",
	"finally",
	"fixed",
	"float",
	"for",
	"foreach",
	"goto",
	"if",
	"implicit",
	"in",
	"int",
	"interface",
	"internal",
	"is",
	"lock",
	"long",
	"namespace",
	"new",
	"null",
	"object",
	"operator",
	"out",
	"override",
	"params",
	"private",
	"protected",
	"public",
	"readonly",
	"ref",
	"return",
	"sbyte",
	"sealed",
	"short",
	"sizeof",
	"stackalloc",
	"static",
	"string",
	"struct",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"uint",
	"ulong",
	"unchecked",
	"unsafe",
	"ushort",
	"using",
	"virtual",
	"void",
	"volatile",
	"while",
]);

const EXTENSIONS = [".cs"] as const;

const NAMESPACE_DECLARATION = "namespace_declaration";
const FILE_SCOPED_NAMESPACE_DECLARATION = "file_scoped_namespace_declaration";
const CLASS_DECLARATION = "class_declaration";
const STRUCT_DECLARATION = "struct_declaration";
const RECORD_DECLARATION = "record_declaration";
const INTERFACE_DECLARATION = "interface_declaration";
const ENUM_DECLARATION = "enum_declaration";
const METHOD_DECLARATION = "method_declaration";
const PROPERTY_DECLARATION = "property_declaration";
const FIELD_DECLARATION = "field_declaration";
const CONSTRUCTOR_DECLARATION = "constructor_declaration";
const EVENT_FIELD_DECLARATION = "event_field_declaration";
const EVENT_DECLARATION = "event_declaration";
const DELEGATE_DECLARATION = "delegate_declaration";
const OPERATOR_DECLARATION = "operator_declaration";
const INDEXER_DECLARATION = "indexer_declaration";
const ENUM_MEMBER_DECLARATION = "enum_member_declaration";
const DECLARATION_LIST = "declaration_list";
const ENUM_MEMBER_DECLARATION_LIST = "enum_member_declaration_list";
const VARIABLE_DECLARATION = "variable_declaration";
const VARIABLE_DECLARATOR = "variable_declarator";
const USING_DIRECTIVE = "using_directive";
const MODIFIER = "modifier";
const COMMENT = "comment";

const INVOCATION = "invocation_expression";
const OBJECT_CREATION = "object_creation_expression";
const BASE_LIST = "base_list";
const IDENTIFIER = "identifier";

const NESTED_SCOPE = new Set([
	"method_declaration",
	"constructor_declaration",
	"local_function_statement",
	"class_declaration",
	"struct_declaration",
	"interface_declaration",
	"record_declaration",
]);

function extractCalls(body: Node | null): CallSite[] {
	if (body === null) return [];
	const out: CallSite[] = [];
	walkBodyNodes(
		body,
		(n) => NESTED_SCOPE.has(n.type),
		(node) => {
			if (node.type === INVOCATION) {
				const fn = field(node, "function");
				if (fn === null) return;
				let leaf = fn;
				let receiver = "";
				if (fn.type === "member_access_expression") {
					const name = field(fn, "name");
					const expr = field(fn, "expression");
					if (name !== null) leaf = name;
					receiver = expr === null ? "" : expr.text;
				}
				const site = callSite(leaf.text, startLine(leaf), leaf.startIndex, leaf.endIndex, "call", receiver);
				if (site !== undefined) out.push(site);
				return;
			}
			if (node.type === OBJECT_CREATION || node.type === "implicit_object_creation_expression") {
				const typeNode = field(node, "type");
				if (typeNode === null) return;
				const ids = typeNode.descendantsOfType(IDENTIFIER);
				const leaf = ids[ids.length - 1];
				if (leaf === undefined) return;
				const site = callSite(leaf.text, startLine(leaf), leaf.startIndex, leaf.endIndex, "construct");
				if (site !== undefined) out.push(site);
			}
		},
	);
	return out;
}

/** Base type simple name — drop namespace qualifiers and type arguments. */
function typeSimpleName(node: Node): string {
	if (node.type === IDENTIFIER) return node.text;
	if (node.type === "generic_name") {
		const id = node.namedChildren.find((c) => c.type === IDENTIFIER);
		return id === undefined ? "" : id.text;
	}
	if (node.type === "qualified_name") {
		const last = node.namedChildren[node.namedChildren.length - 1];
		return last === undefined ? "" : typeSimpleName(last);
	}
	for (const child of node.namedChildren) {
		const inner = typeSimpleName(child);
		if (inner.length > 0) return inner;
	}
	return "";
}

function heritageBases(node: Node): string[] {
	const bases: string[] = [];
	for (const child of node.namedChildren) {
		if (child.type !== BASE_LIST) continue;
		for (const entry of child.namedChildren) {
			const name = typeSimpleName(entry);
			if (name.length > 0) bases.push(name);
		}
	}
	return [...new Set(bases)];
}

function csDoc(node: Node, source: string): DocSpan | undefined {
	return docSpanBefore(node, source);
}

function modifiersOf(node: Node): string[] {
	const out: string[] = [];
	for (const child of node.namedChildren) {
		if (child.type === MODIFIER) out.push(child.text);
	}
	return out;
}

function visibilityFromModifiers(mods: readonly string[], defaultVisibility: Visibility): Visibility {
	if (mods.includes("public")) return "public";
	if (mods.includes("private")) return "private";
	if (mods.includes("protected")) return "protected";
	if (mods.includes("internal")) return "internal";
	return defaultVisibility;
}

function typeVisibility(node: Node): Visibility {
	return visibilityFromModifiers(modifiersOf(node), "internal");
}

function nameOf(node: Node): string {
	return nameText(field(node, "name"));
}

function bodyOf(node: Node): Node | null {
	return field(node, "body") ?? field(node, "accessors") ?? field(node, "value");
}

const leaf = createLeafBuilder(extractCalls, heritageBases);

function variableNames(declaration: Node | null): string[] {
	if (declaration === null || declaration.type !== VARIABLE_DECLARATION) return [];
	const names: string[] = [];
	for (const child of declaration.namedChildren) {
		if (child.type !== VARIABLE_DECLARATOR) continue;
		const name = nameText(field(child, "name"));
		if (name.length > 0) names.push(name);
	}
	return names;
}

function enumMembers(list: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	for (const node of list.namedChildren) {
		if (node.type !== ENUM_MEMBER_DECLARATION) continue;
		const decl = leaf(node, owner, "enumMember", nameOf(node), "public", null, [], undefined);
		if (decl !== undefined) out.push(decl);
	}
	return out;
}

function membersFromList(list: Node, owner: string, source: string, defaultMemberVisibility: Visibility): Decl[] {
	const out: Decl[] = [];
	for (const node of list.namedChildren) {
		if (node.type === COMMENT) continue;
		out.push(...declsFromNode(node, owner, source, defaultMemberVisibility));
	}
	return out;
}

function declsFromNode(node: Node, owner: string, source: string, defaultMemberVisibility: Visibility): Decl[] {
	if (node.isError || node.type === "ERROR") {
		const out: Decl[] = [];
		for (const child of node.children) {
			if (child.isNamed || child.isError) {
				out.push(...declsFromNode(child, owner, source, defaultMemberVisibility));
			}
		}
		return out;
	}

	const doc = csDoc(node, source);
	const memberVis = visibilityFromModifiers(modifiersOf(node), defaultMemberVisibility);

	switch (node.type) {
		case NAMESPACE_DECLARATION: {
			const name = nameOf(node);
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children =
				body !== null && body.type === DECLARATION_LIST ? membersFromList(body, qn, source, "private") : [];
			const decl = leaf(node, owner, "namespace", name, "public", body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case FILE_SCOPED_NAMESPACE_DECLARATION: {
			// Body is siblings of the file-scoped node; handled by extract walk.
			const name = nameOf(node);
			const decl = leaf(node, owner, "namespace", name, "public", null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case CLASS_DECLARATION:
		case RECORD_DECLARATION: {
			// record class → class; record struct → struct.
			const name = nameOf(node);
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children =
				body !== null && body.type === DECLARATION_LIST ? membersFromList(body, qn, source, "private") : [];
			const isRecordStruct =
				node.type === RECORD_DECLARATION && node.children.some((child) => child.type === "struct");
			const kind = isRecordStruct ? "struct" : "class";
			const decl = leaf(node, owner, kind, name, typeVisibility(node), body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case STRUCT_DECLARATION: {
			const name = nameOf(node);
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children =
				body !== null && body.type === DECLARATION_LIST ? membersFromList(body, qn, source, "private") : [];
			const decl = leaf(node, owner, "struct", name, typeVisibility(node), body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case INTERFACE_DECLARATION: {
			const name = nameOf(node);
			const body = field(node, "body");
			const qn = qualify(owner, name);
			// Interface members default public in C#.
			const children =
				body !== null && body.type === DECLARATION_LIST ? membersFromList(body, qn, source, "public") : [];
			const decl = leaf(node, owner, "interface", name, typeVisibility(node), body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case ENUM_DECLARATION: {
			const name = nameOf(node);
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children = body !== null && body.type === ENUM_MEMBER_DECLARATION_LIST ? enumMembers(body, qn) : [];
			const decl = leaf(node, owner, "enum", name, typeVisibility(node), body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case METHOD_DECLARATION: {
			const decl = leaf(node, owner, "method", nameOf(node), memberVis, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case CONSTRUCTOR_DECLARATION: {
			const decl = leaf(node, owner, "constructor", nameOf(node), memberVis, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case PROPERTY_DECLARATION:
		case INDEXER_DECLARATION: {
			const name = node.type === INDEXER_DECLARATION ? "this" : nameOf(node);
			const decl = leaf(node, owner, "property", name, memberVis, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case OPERATOR_DECLARATION: {
			const op = field(node, "operator");
			const name = op === null ? "operator" : `operator ${op.text}`;
			const decl = leaf(node, owner, "operator", name, memberVis, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case FIELD_DECLARATION:
		case EVENT_FIELD_DECLARATION: {
			const kind = node.type === EVENT_FIELD_DECLARATION ? "event" : "field";
			const names = variableNames(node.namedChildren.find((c) => c.type === VARIABLE_DECLARATION) ?? null);
			const out: Decl[] = [];
			for (let i = 0; i < names.length; i += 1) {
				const name = names[i];
				if (name === undefined) continue;
				const decl = leaf(node, owner, kind, name, memberVis, null, [], i === 0 ? doc : undefined);
				if (decl !== undefined) out.push(decl);
			}
			return out;
		}
		case EVENT_DECLARATION: {
			const decl = leaf(node, owner, "event", nameOf(node), memberVis, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case DELEGATE_DECLARATION: {
			// Delegate type → function (closest shared kind).
			const decl = leaf(node, owner, "function", nameOf(node), typeVisibility(node), null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		default:
			return [];
	}
}

function collectImports(root: Node): ImportRef[] {
	const imports: ImportRef[] = [];
	for (const node of root.namedChildren) {
		if (node.type !== USING_DIRECTIVE) continue;
		// using X; / using static X; / using Alias = X.Y; — the imported target is the
		// last name child, so an alias name never masks what it points at.
		const nameNode =
			node.namedChildren.filter((child) => child.type === "identifier" || child.type === "qualified_name").at(-1) ??
			null;
		const specifier = nameNode === null ? node.text.replace(/^using\s+/, "").replace(/;$/, "") : nameNode.text;
		imports.push({
			specifier,
			startLine: startLine(node),
			startOffset: node.startIndex,
			endOffset: node.endIndex,
			bindings: [],
		});
	}
	return imports;
}

function extractCsharp(tree: Tree, source: string): ExtractResult {
	const root = tree.rootNode;
	const decls: Decl[] = [];
	// File-scoped namespace owns following type siblings for qualifiedName nesting.
	let fileScopedOwner = "";
	let fileScopedNamespace: Decl | undefined;

	for (const node of root.children) {
		if (!(node.isNamed || node.isError)) continue;

		if (node.type === FILE_SCOPED_NAMESPACE_DECLARATION) {
			const extracted = declsFromNode(node, "", source, "private");
			const ns = extracted[0];
			if (ns !== undefined) {
				fileScopedNamespace = ns;
				fileScopedOwner = ns.qualifiedName;
				decls.push(ns);
			}
			continue;
		}

		if (node.type === USING_DIRECTIVE || node.type === COMMENT) continue;

		const owner = fileScopedOwner;
		const extracted = declsFromNode(node, owner, source, "private");
		if (fileScopedNamespace !== undefined && owner.length > 0) {
			fileScopedNamespace.children.push(...extracted);
		} else {
			decls.push(...extracted);
		}
	}

	return { decls, imports: collectImports(root), fileCalls: extractCalls(root) };
}

export function csharpAdapter(): GrammarAdapter {
	return {
		mode: "grammar",
		id: "c_sharp",
		extensions: EXTENSIONS,
		capabilities: CAPABILITIES,
		importNoiseIdentifiers: IMPORT_NOISE,
		extract: extractCsharp,
		resolveFileDep: resolveCsharpFileDep,
	};
}
