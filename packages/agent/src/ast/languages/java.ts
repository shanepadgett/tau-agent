import type { Node, Tree } from "web-tree-sitter";
import type { ExtractResult, GrammarAdapter, LanguageCapabilities } from "../adapter.ts";
import { resolveJavaFileDep } from "./jvm-file-deps.ts";
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
	"assert",
	"boolean",
	"break",
	"byte",
	"case",
	"catch",
	"char",
	"class",
	"const",
	"continue",
	"default",
	"do",
	"double",
	"else",
	"enum",
	"extends",
	"final",
	"finally",
	"float",
	"for",
	"goto",
	"if",
	"implements",
	"import",
	"instanceof",
	"int",
	"interface",
	"long",
	"native",
	"new",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"short",
	"static",
	"strictfp",
	"super",
	"switch",
	"synchronized",
	"this",
	"throw",
	"throws",
	"transient",
	"try",
	"void",
	"volatile",
	"while",
	"true",
	"false",
	"null",
]);

const EXTENSIONS = [".java"] as const;

const CLASS_DECLARATION = "class_declaration";
const INTERFACE_DECLARATION = "interface_declaration";
const ENUM_DECLARATION = "enum_declaration";
const RECORD_DECLARATION = "record_declaration";
const ANNOTATION_TYPE_DECLARATION = "annotation_type_declaration";
const METHOD_DECLARATION = "method_declaration";
const CONSTRUCTOR_DECLARATION = "constructor_declaration";
const FIELD_DECLARATION = "field_declaration";
const CONSTANT_DECLARATION = "constant_declaration";
const ENUM_CONSTANT = "enum_constant";
const ENUM_BODY = "enum_body";
const ENUM_BODY_DECLARATIONS = "enum_body_declarations";
const ANNOTATION_TYPE_ELEMENT_DECLARATION = "annotation_type_element_declaration";
const VARIABLE_DECLARATOR = "variable_declarator";
const IMPORT_DECLARATION = "import_declaration";
const MODIFIERS = "modifiers";
const LINE_COMMENT = "line_comment";
const BLOCK_COMMENT = "block_comment";

const COMMENT_TYPES = [LINE_COMMENT, BLOCK_COMMENT] as const;

const CALL_METHOD = "method_invocation";
const OBJECT_CREATION = "object_creation_expression";
const ARRAY_CREATION = "array_creation_expression";
const SUPERCLASS = "superclass";
const SUPER_INTERFACES = "super_interfaces";
const TYPE_IDENTIFIER = "type_identifier";

const NESTED_SCOPE = new Set([
	"method_declaration",
	"constructor_declaration",
	"class_declaration",
	"interface_declaration",
	"enum_declaration",
	"record_declaration",
]);

function extractCalls(body: Node | null): CallSite[] {
	if (body === null) return [];
	const out: CallSite[] = [];
	walkBodyNodes(
		body,
		(n) => NESTED_SCOPE.has(n.type),
		(node) => {
			if (node.type === CALL_METHOD) {
				const nameNode = field(node, "name");
				const obj = field(node, "object");
				if (nameNode === null) return;
				const site = callSite(
					nameNode.text,
					startLine(nameNode),
					nameNode.startIndex,
					nameNode.endIndex,
					"call",
					obj === null ? "" : obj.text,
				);
				if (site !== undefined) out.push(site);
				return;
			}
			if (node.type === OBJECT_CREATION || node.type === ARRAY_CREATION) {
				const typeNode = field(node, "type");
				if (typeNode === null) return;
				const leaf = typeNode.type === TYPE_IDENTIFIER ? typeNode : typeNode.descendantsOfType(TYPE_IDENTIFIER)[0];
				if (leaf === undefined) return;
				const site = callSite(leaf.text, startLine(leaf), leaf.startIndex, leaf.endIndex, "construct");
				if (site !== undefined) out.push(site);
			}
		},
	);
	return out;
}

/** Simple type name only — drop package path and type arguments. */
function typeSimpleName(node: Node): string {
	if (node.type === TYPE_IDENTIFIER || node.type === "identifier") return node.text;
	if (node.type === "generic_type" || node.type === "annotated_type") {
		const inner = field(node, "type") ?? node.namedChildren[0];
		return inner === undefined ? "" : typeSimpleName(inner);
	}
	if (node.type === "scoped_type_identifier") {
		const name = field(node, "name");
		if (name !== null) return name.text;
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
	const pushTypes = (clause: Node): void => {
		const list = clause.namedChildren.find((c) => c.type === "type_list") ?? clause;
		for (const t of list.namedChildren) {
			const name = typeSimpleName(t);
			if (name.length > 0) bases.push(name);
		}
	};
	for (const child of node.namedChildren) {
		if (
			child.type === SUPERCLASS ||
			child.type === SUPER_INTERFACES ||
			child.type === "extends_interfaces" ||
			child.type === "super_interfaces"
		) {
			pushTypes(child);
		}
	}
	return [...new Set(bases)];
}

function javaDoc(node: Node, source: string): DocSpan | undefined {
	return docSpanBefore(node, source, [], COMMENT_TYPES);
}

function modifiersText(node: Node): string {
	const mods = node.namedChildren.find((child) => child.type === MODIFIERS);
	return mods === undefined ? "" : mods.text;
}

function javaVisibility(node: Node, defaultVisibility: Visibility): Visibility {
	const text = modifiersText(node);
	if (/\bpublic\b/.test(text)) return "public";
	if (/\bprivate\b/.test(text)) return "private";
	if (/\bprotected\b/.test(text)) return "protected";
	// package-private default for types/class members; interface members default public.
	return defaultVisibility;
}

function nameOf(node: Node): string {
	return nameText(field(node, "name"));
}

const leaf = createLeafBuilder(extractCalls, heritageBases);

function declaratorNames(node: Node): string[] {
	const names: string[] = [];
	for (const child of node.namedChildren) {
		if (child.type !== VARIABLE_DECLARATOR) continue;
		const name = nameText(field(child, "name"));
		if (name.length > 0) names.push(name);
	}
	// constant_declaration uses field "declarator"
	const single = field(node, "declarator");
	if (single !== null && single.type === VARIABLE_DECLARATOR) {
		const name = nameText(field(single, "name"));
		if (name.length > 0 && !names.includes(name)) names.push(name);
	}
	return names;
}

function walkBody(body: Node, owner: string, source: string, defaultMemberVisibility: Visibility): Decl[] {
	const out: Decl[] = [];
	for (const node of body.namedChildren) {
		if (node.type === LINE_COMMENT || node.type === BLOCK_COMMENT) continue;
		if (node.type === ENUM_BODY_DECLARATIONS) {
			out.push(...walkBody(node, owner, source, defaultMemberVisibility));
			continue;
		}
		out.push(...declsFromNode(node, owner, source, defaultMemberVisibility));
	}
	return out;
}

function enumConstants(body: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	for (const node of body.namedChildren) {
		if (node.type !== ENUM_CONSTANT) continue;
		const decl = leaf(node, owner, "enumMember", nameOf(node), "public", null, [], undefined);
		if (decl !== undefined) out.push(decl);
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

	const doc = javaDoc(node, source);
	const visibility = javaVisibility(node, defaultMemberVisibility);

	switch (node.type) {
		case CLASS_DECLARATION:
		case RECORD_DECLARATION: {
			const name = nameOf(node);
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children = body !== null ? walkBody(body, qn, source, "internal") : [];
			const decl = leaf(node, owner, "class", name, javaVisibility(node, "internal"), body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case INTERFACE_DECLARATION:
		case ANNOTATION_TYPE_DECLARATION: {
			// @interface → interface. Members default public.
			const name = nameOf(node);
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children = body !== null ? walkBody(body, qn, source, "public") : [];
			const decl = leaf(node, owner, "interface", name, javaVisibility(node, "internal"), body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case ENUM_DECLARATION: {
			const name = nameOf(node);
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children: Decl[] = [];
			if (body !== null && body.type === ENUM_BODY) {
				children.push(...enumConstants(body, qn));
				children.push(...walkBody(body, qn, source, "internal"));
			}
			const decl = leaf(node, owner, "enum", name, javaVisibility(node, "internal"), body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case METHOD_DECLARATION: {
			const decl = leaf(node, owner, "method", nameOf(node), visibility, field(node, "body"), [], doc);
			return decl === undefined ? [] : [decl];
		}
		case CONSTRUCTOR_DECLARATION: {
			const body = field(node, "body");
			const decl = leaf(node, owner, "constructor", nameOf(node), visibility, body, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case FIELD_DECLARATION:
		case CONSTANT_DECLARATION: {
			const names = declaratorNames(node);
			const kind =
				node.type === CONSTANT_DECLARATION || /\bfinal\b/.test(modifiersText(node)) ? "constant" : "field";
			const out: Decl[] = [];
			for (let i = 0; i < names.length; i += 1) {
				const name = names[i];
				if (name === undefined) continue;
				const decl = leaf(node, owner, kind, name, visibility, null, [], i === 0 ? doc : undefined);
				if (decl !== undefined) out.push(decl);
			}
			return out;
		}
		case ANNOTATION_TYPE_ELEMENT_DECLARATION: {
			const decl = leaf(node, owner, "method", nameOf(node), visibility, null, [], doc);
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
		// Keep full import path text without the keyword.
		const specifier = node.text
			.replace(/^import\s+/, "")
			.replace(/^static\s+/, "")
			.replace(/;$/, "")
			.trim();
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

function extractJava(tree: Tree, source: string): ExtractResult {
	const root = tree.rootNode;
	const decls: Decl[] = [];
	for (const node of root.children) {
		if (node.isNamed || node.isError) decls.push(...declsFromNode(node, "", source, "internal"));
	}
	return { decls, imports: collectImports(root), fileCalls: extractCalls(root) };
}

export function javaAdapter(): GrammarAdapter {
	return {
		mode: "grammar",
		id: "java",
		extensions: EXTENSIONS,
		capabilities: CAPABILITIES,
		importNoiseIdentifiers: IMPORT_NOISE,
		extract: extractJava,
		resolveFileDep: resolveJavaFileDep,
	};
}
