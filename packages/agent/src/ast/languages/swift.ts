import type { Node, Tree } from "web-tree-sitter";
import type { ExtractResult, GrammarAdapter, LanguageCapabilities } from "../adapter.ts";
import { resolveSwiftFileDep } from "./swift-file-deps.ts";
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
	"associatedtype",
	"class",
	"deinit",
	"enum",
	"extension",
	"fileprivate",
	"func",
	"import",
	"init",
	"inout",
	"internal",
	"let",
	"open",
	"operator",
	"private",
	"protocol",
	"public",
	"rethrows",
	"static",
	"struct",
	"subscript",
	"typealias",
	"var",
	"break",
	"case",
	"continue",
	"default",
	"defer",
	"do",
	"else",
	"fallthrough",
	"for",
	"guard",
	"if",
	"in",
	"repeat",
	"return",
	"switch",
	"where",
	"while",
	"as",
	"Any",
	"catch",
	"false",
	"is",
	"nil",
	"super",
	"self",
	"Self",
	"throw",
	"throws",
	"true",
	"try",
]);

const EXTENSIONS = [".swift"] as const;

const CLASS_DECLARATION = "class_declaration";
const PROTOCOL_DECLARATION = "protocol_declaration";
const FUNCTION_DECLARATION = "function_declaration";
const PROPERTY_DECLARATION = "property_declaration";
const INIT_DECLARATION = "init_declaration";
const DEINIT_DECLARATION = "deinit_declaration";
const SUBSCRIPT_DECLARATION = "subscript_declaration";
const TYPEALIAS_DECLARATION = "typealias_declaration";
const PROTOCOL_FUNCTION_DECLARATION = "protocol_function_declaration";
const PROTOCOL_PROPERTY_DECLARATION = "protocol_property_declaration";
const ASSOCIATEDTYPE_DECLARATION = "associatedtype_declaration";
const ENUM_ENTRY = "enum_entry";
const CLASS_BODY = "class_body";
const ENUM_CLASS_BODY = "enum_class_body";
const PROTOCOL_BODY = "protocol_body";
const IMPORT_DECLARATION = "import_declaration";
const MODIFIERS = "modifiers";
const VISIBILITY_MODIFIER = "visibility_modifier";
const TYPE_IDENTIFIER = "type_identifier";
const USER_TYPE = "user_type";
const SIMPLE_IDENTIFIER = "simple_identifier";
const COMMENT = "comment";

const NESTED_SCOPE = new Set([
	"function_declaration",
	"class_declaration",
	"struct_declaration",
	"enum_declaration",
	"protocol_declaration",
]);

function extractCalls(body: Node | null): CallSite[] {
	if (body === null) return [];
	const out: CallSite[] = [];
	walkBodyNodes(
		body,
		(n) => NESTED_SCOPE.has(n.type),
		(node) => {
			if (node.type === "call_expression") {
				const fn = node.namedChildren[0];
				if (fn === undefined) return;
				let leafNode = fn;
				let receiver = "";
				if (fn.type === "navigation_expression") {
					const ids = fn.descendantsOfType("simple_identifier");
					const last = ids[ids.length - 1];
					if (last !== undefined) leafNode = last;
					receiver = fn.text.slice(0, Math.max(0, fn.text.length - leafNode.text.length - 1));
				}
				const site = callSite(
					leafNode.text,
					startLine(leafNode),
					leafNode.startIndex,
					leafNode.endIndex,
					"call",
					receiver,
				);
				if (site !== undefined) out.push(site);
				return;
			}
			if (node.type === "constructor_expression") {
				const ids = node.descendantsOfType("type_identifier");
				const leafNode = ids[0];
				if (leafNode === undefined) return;
				const site = callSite(
					leafNode.text,
					startLine(leafNode),
					leafNode.startIndex,
					leafNode.endIndex,
					"construct",
				);
				if (site !== undefined) out.push(site);
			}
		},
	);
	return out;
}

function heritageBases(node: Node): string[] {
	const bases: string[] = [];
	for (const child of node.namedChildren) {
		if (child.type === "inheritance_specifier" || child.type === "type_inheritance_clause") {
			for (const t of child.descendantsOfType("type_identifier")) {
				if (t.text.length > 0) bases.push(t.text);
			}
		}
	}
	return [...new Set(bases)];
}

function swiftDoc(node: Node, source: string): DocSpan | undefined {
	return docSpanBefore(node, source);
}

function visibilityOf(node: Node): Visibility {
	const mods = node.namedChildren.find((child) => child.type === MODIFIERS);
	if (mods === undefined) return "internal";
	for (const child of mods.namedChildren) {
		if (child.type !== VISIBILITY_MODIFIER) continue;
		const text = child.text;
		if (text === "open" || text === "public") return "public";
		if (text === "internal") return "internal";
		if (text === "fileprivate" || text === "private") return "private";
	}
	return "internal";
}

function declarationKind(node: Node): string {
	const kind = field(node, "declaration_kind");
	return kind === null ? "" : kind.text;
}

function typeName(node: Node): string {
	const named = field(node, "name");
	if (named === null) return "";
	if (named.type === TYPE_IDENTIFIER) return named.text;
	if (named.type === USER_TYPE) {
		// Keep dotted path for `extension Foo.Bar` (not only the first segment).
		return named.text.replace(/\s+/g, "");
	}
	return named.text;
}

function simpleName(node: Node | null): string {
	if (node === null) return "";
	if (node.type === SIMPLE_IDENTIFIER) return node.text;
	const inner = node.namedChildren.find((child) => child.type === SIMPLE_IDENTIFIER);
	return inner === undefined ? nameText(node) : inner.text;
}

function propertyName(node: Node): string {
	const pattern = field(node, "name");
	if (pattern === null) {
		// protocol_property_declaration nests pattern differently.
		const nested = node.namedChildren.find((child) => child.type === "pattern");
		return simpleName(nested ?? null);
	}
	if (pattern.type === "pattern") {
		const bound = field(pattern, "bound_identifier");
		if (bound !== null) return simpleName(bound);
		return simpleName(pattern.namedChildren.find((child) => child.type === SIMPLE_IDENTIFIER) ?? null);
	}
	return simpleName(pattern);
}

function functionName(node: Node): string {
	const name = field(node, "name");
	if (name !== null) return simpleName(name);
	return simpleName(node.namedChildren.find((child) => child.type === SIMPLE_IDENTIFIER) ?? null);
}

function bodyOf(node: Node): Node | null {
	return (
		field(node, "body") ??
		field(node, "computed_value") ??
		node.namedChildren.find((child) => child.type === "function_body" || child.type === "computed_property") ??
		null
	);
}

const leaf = createLeafBuilder(extractCalls, heritageBases);

function classKind(kindText: string): Decl["kind"] {
	if (kindText === "struct") return "struct";
	if (kindText === "enum") return "enum";
	if (kindText === "actor") return "class";
	return "class";
}

const TYPE_KINDS = new Set<Decl["kind"]>(["class", "struct", "enum", "interface", "object"]);

function findTypeDecl(decls: readonly Decl[], typeQn: string): Decl | undefined {
	for (const decl of decls) {
		if (TYPE_KINDS.has(decl.kind) && decl.qualifiedName === typeQn) return decl;
		const nested = findTypeDecl(decl.children, typeQn);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

/**
 * Same-file extensions: attach members under the extended type's children.
 * Type not in this file: keep top-level decls with Type.member qualifiedName.
 */
function mergeExtensionMembers(decls: Decl[], extensions: readonly { typeQn: string; members: Decl[] }[]): Decl[] {
	const leftover: Decl[] = [];
	for (const ext of extensions) {
		const target = findTypeDecl(decls, ext.typeQn);
		if (target === undefined) {
			leftover.push(...ext.members);
			continue;
		}
		target.children.push(...ext.members);
	}
	if (leftover.length === 0) return decls;
	return [...decls, ...leftover];
}

function walkBody(body: Node, owner: string, source: string): Decl[] {
	const out: Decl[] = [];
	for (const node of body.namedChildren) {
		if (node.type === COMMENT) continue;
		if (node.type === ENUM_ENTRY) {
			const name = simpleName(
				field(node, "name") ?? node.namedChildren.find((c) => c.type === SIMPLE_IDENTIFIER) ?? null,
			);
			const decl = leaf(node, owner, "enumMember", name, "public", null, [], undefined);
			if (decl !== undefined) out.push(decl);
			continue;
		}
		out.push(...declsFromNode(node, owner, source));
	}
	return out;
}

function declsFromNode(node: Node, owner: string, source: string): Decl[] {
	if (node.isError || node.type === "ERROR") {
		const out: Decl[] = [];
		for (const child of node.children) {
			if (child.isNamed || child.isError) out.push(...declsFromNode(child, owner, source));
		}
		return out;
	}

	const doc = swiftDoc(node, source);
	const visibility = visibilityOf(node);

	switch (node.type) {
		case CLASS_DECLARATION: {
			const kindText = declarationKind(node);
			const name = typeName(node);
			const body =
				field(node, "body") ??
				node.namedChildren.find((child) => child.type === CLASS_BODY || child.type === ENUM_CLASS_BODY) ??
				null;

			// Extensions are collected by extractSwift and merged onto same-file types.
			if (kindText === "extension") return [];

			const qn = qualify(owner, name);
			const children = body === null ? [] : walkBody(body, qn, source);
			const decl = leaf(node, owner, classKind(kindText), name, visibility, body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case PROTOCOL_DECLARATION: {
			const name = typeName(node);
			const body = field(node, "body") ?? node.namedChildren.find((child) => child.type === PROTOCOL_BODY) ?? null;
			const qn = qualify(owner, name);
			const children = body === null ? [] : walkBody(body, qn, source);
			const decl = leaf(node, owner, "interface", name, visibility, body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case FUNCTION_DECLARATION:
		case PROTOCOL_FUNCTION_DECLARATION: {
			const name = functionName(node);
			const kind = owner.length > 0 ? "method" : "function";
			const decl = leaf(node, owner, kind, name, visibility, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case INIT_DECLARATION: {
			const decl = leaf(node, owner, "constructor", "init", visibility, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case DEINIT_DECLARATION: {
			const decl = leaf(node, owner, "method", "deinit", visibility, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case SUBSCRIPT_DECLARATION: {
			const decl = leaf(node, owner, "method", "subscript", visibility, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case PROPERTY_DECLARATION:
		case PROTOCOL_PROPERTY_DECLARATION: {
			const name = propertyName(node);
			const decl = leaf(node, owner, "property", name, visibility, bodyOf(node), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case TYPEALIAS_DECLARATION: {
			const name = typeName(node);
			const decl = leaf(node, owner, "typeAlias", name, visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case ASSOCIATEDTYPE_DECLARATION: {
			const name = typeName(node);
			const decl = leaf(node, owner, "typeParameter", name, visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		default:
			return [];
	}
}

function collectImports(root: Node): ImportRef[] {
	const imports: ImportRef[] = [];
	for (const node of root.namedChildren) {
		if (node.type !== IMPORT_DECLARATION) continue;
		const id = node.namedChildren.find((child) => child.type === "identifier" || child.type === SIMPLE_IDENTIFIER);
		const specifier = id === undefined ? node.text.replace(/^import\s+/, "").trim() : id.text.replace(/\s+/g, "");
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

function extensionMembers(node: Node, owner: string, source: string): { typeQn: string; members: Decl[] } | undefined {
	if (node.type !== CLASS_DECLARATION || declarationKind(node) !== "extension") return undefined;
	const name = typeName(node);
	const typeQn = owner.length === 0 ? name : qualify(owner, name);
	if (typeQn.length === 0) return undefined;
	const body =
		field(node, "body") ??
		node.namedChildren.find((child) => child.type === CLASS_BODY || child.type === ENUM_CLASS_BODY) ??
		null;
	if (body === null) return { typeQn, members: [] };
	return { typeQn, members: walkBody(body, typeQn, source) };
}

function extractSwift(tree: Tree, source: string): ExtractResult {
	const root = tree.rootNode;
	const decls: Decl[] = [];
	const extensions: { typeQn: string; members: Decl[] }[] = [];
	for (const node of root.children) {
		if (!(node.isNamed || node.isError)) continue;
		const ext = extensionMembers(node, "", source);
		if (ext !== undefined) {
			extensions.push(ext);
			continue;
		}
		decls.push(...declsFromNode(node, "", source));
	}
	return {
		decls: mergeExtensionMembers(decls, extensions),
		imports: collectImports(root),
		fileCalls: extractCalls(root),
	};
}

export function swiftAdapter(): GrammarAdapter {
	return {
		mode: "grammar",
		id: "swift",
		extensions: EXTENSIONS,
		capabilities: CAPABILITIES,
		importNoiseIdentifiers: IMPORT_NOISE,
		extract: extractSwift,
		resolveFileDep: resolveSwiftFileDep,
	};
}
