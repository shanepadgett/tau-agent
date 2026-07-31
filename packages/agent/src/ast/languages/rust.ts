import type { Node, Tree } from "web-tree-sitter";
import type { ExtractResult, GrammarAdapter, LanguageCapabilities } from "../adapter.ts";
import { resolveRustFileDep } from "./rust-file-deps.ts";
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
	spanThroughPrevious,
	startLine,
	walkBodyNodes,
	type DocSpan,
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
	"as",
	"async",
	"await",
	"break",
	"const",
	"continue",
	"crate",
	"dyn",
	"else",
	"enum",
	"extern",
	"false",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"match",
	"mod",
	"move",
	"mut",
	"pub",
	"ref",
	"return",
	"self",
	"Self",
	"static",
	"struct",
	"super",
	"trait",
	"true",
	"type",
	"unsafe",
	"use",
	"where",
	"while",
]);

const EXTENSIONS = [".rs"] as const;

const FUNCTION_ITEM = "function_item";
const FUNCTION_SIGNATURE_ITEM = "function_signature_item";
const STRUCT_ITEM = "struct_item";
const ENUM_ITEM = "enum_item";
const TRAIT_ITEM = "trait_item";
const IMPL_ITEM = "impl_item";
const MOD_ITEM = "mod_item";
const CONST_ITEM = "const_item";
const STATIC_ITEM = "static_item";
const TYPE_ITEM = "type_item";
const UNION_ITEM = "union_item";
const ASSOCIATED_TYPE = "associated_type";
const USE_DECLARATION = "use_declaration";
const ATTRIBUTE_ITEM = "attribute_item";
const VISIBILITY_MODIFIER = "visibility_modifier";
const FIELD_DECLARATION = "field_declaration";
const FIELD_DECLARATION_LIST = "field_declaration_list";
const ENUM_VARIANT = "enum_variant";
const ENUM_VARIANT_LIST = "enum_variant_list";
const DECLARATION_LIST = "declaration_list";
const TYPE_IDENTIFIER = "type_identifier";
const GENERIC_TYPE = "generic_type";
const SCOPED_TYPE_IDENTIFIER = "scoped_type_identifier";
const LINE_COMMENT = "line_comment";
const BLOCK_COMMENT = "block_comment";

const CALL_EXPRESSION = "call_expression";
const MACRO_INVOCATION = "macro_invocation";
const STRUCT_EXPRESSION = "struct_expression";
const IDENTIFIER = "identifier";
const FIELD_IDENTIFIER = "field_identifier";
const SCOPED_IDENTIFIER = "scoped_identifier";

const NESTED_SCOPE = new Set([
	FUNCTION_ITEM,
	FUNCTION_SIGNATURE_ITEM,
	STRUCT_ITEM,
	ENUM_ITEM,
	TRAIT_ITEM,
	IMPL_ITEM,
	MOD_ITEM,
]);

function bareCallee(node: Node): { name: string; receiver: string; leaf: Node } | undefined {
	if (node.type === IDENTIFIER || node.type === FIELD_IDENTIFIER) {
		return { name: node.text, receiver: "", leaf: node };
	}
	if (node.type === SCOPED_IDENTIFIER || node.type === "field_expression") {
		const nameNode = field(node, "name") ?? field(node, "field");
		const scope = field(node, "path") ?? field(node, "value");
		if (nameNode === null) return undefined;
		return { name: nameNode.text, receiver: scope === null ? "" : scope.text, leaf: nameNode };
	}
	return undefined;
}

function extractCalls(body: Node | null): CallSite[] {
	if (body === null) return [];
	const out: CallSite[] = [];
	walkBodyNodes(
		body,
		(n) => NESTED_SCOPE.has(n.type),
		(node) => {
			if (node.type === CALL_EXPRESSION) {
				const fn = field(node, "function");
				if (fn === null) return;
				const bare = bareCallee(fn);
				if (bare === undefined) return;
				const site = callSite(
					bare.name,
					startLine(bare.leaf),
					bare.leaf.startIndex,
					bare.leaf.endIndex,
					"call",
					bare.receiver,
				);
				if (site !== undefined) out.push(site);
				return;
			}
			if (node.type === MACRO_INVOCATION) {
				const mac = field(node, "macro") ?? node.namedChildren[0];
				if (mac === undefined || mac === null) return;
				const bare =
					bareCallee(mac) ?? (mac.type === IDENTIFIER ? { name: mac.text, receiver: "", leaf: mac } : undefined);
				if (bare === undefined) return;
				const site = callSite(
					bare.name,
					startLine(bare.leaf),
					bare.leaf.startIndex,
					bare.leaf.endIndex,
					"macro",
					bare.receiver,
				);
				if (site !== undefined) out.push(site);
				return;
			}
			if (node.type === STRUCT_EXPRESSION) {
				const nameNode = field(node, "name");
				if (nameNode === null) return;
				const bare =
					bareCallee(nameNode) ??
					(nameNode.type === TYPE_IDENTIFIER ? { name: nameNode.text, receiver: "", leaf: nameNode } : undefined);
				if (bare === undefined) return;
				const site = callSite(
					bare.name,
					startLine(bare.leaf),
					bare.leaf.startIndex,
					bare.leaf.endIndex,
					"construct",
				);
				if (site !== undefined) out.push(site);
			}
		},
	);
	return out;
}

function traitBase(node: Node): string[] {
	// impl Trait for Type → trait is base of Type for implementation search of Trait
	const trait = field(node, "trait");
	if (trait === null) return [];
	const name = rustTypeName(trait);
	return name.length === 0 ? [] : [name];
}

const COMMENT_TYPES = [LINE_COMMENT, BLOCK_COMMENT] as const;
const ATTR_TYPES = [ATTRIBUTE_ITEM] as const;

function rustDoc(node: Node, source: string): DocSpan | undefined {
	return docSpanBefore(node, source, ATTR_TYPES, COMMENT_TYPES);
}

function rustVisibility(node: Node): Visibility {
	for (const child of node.namedChildren) {
		if (child.type !== VISIBILITY_MODIFIER) continue;
		const text = child.text;
		if (text === "pub") return "public";
		// pub(crate), pub(super), pub(in path)
		return "internal";
	}
	return "private";
}

function rustExported(visibility: Visibility): boolean {
	return visibility === "public" || visibility === "internal";
}

/** Base type name for impl targets (strip path/generics/pointers). */
function rustTypeName(node: Node | null): string {
	if (node === null) return "";
	if (node.type === TYPE_IDENTIFIER) return node.text;
	if (node.type === GENERIC_TYPE) return rustTypeName(field(node, "type"));
	if (node.type === SCOPED_TYPE_IDENTIFIER) {
		const name = field(node, "name");
		if (name !== null) return name.text;
	}
	for (let i = node.namedChildren.length - 1; i >= 0; i -= 1) {
		const child = node.namedChildren[i];
		if (child === undefined) continue;
		const inner = rustTypeName(child);
		if (inner.length > 0) return inner;
	}
	return "";
}

function withAttrSpan(
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
	const span = spanThroughPrevious(node, ATTR_TYPES);
	const callable = kind === "function" || kind === "method" || kind === "constructor";
	const decl = finishDecl(
		{
			kind,
			name,
			qualifiedName: qualify(owner, name),
			startLine: span.startLine,
			endLine: endLine(node),
			startOffset: span.startOffset,
			endOffset: node.endIndex,
			visibility,
			exported: rustExported(visibility),
			children,
			calls: callable ? extractCalls(body) : [],
			bases: node.type === IMPL_ITEM ? traitBase(node) : [],
		},
		body,
	);
	if (body === null) decl.signatureEndOffset = node.endIndex;
	return applyDoc(decl, doc);
}

function structFields(list: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	for (const node of list.namedChildren) {
		if (node.type !== FIELD_DECLARATION) continue;
		const name = nameText(field(node, "name"));
		if (name.length === 0) continue;
		const visibility = rustVisibility(node);
		out.push({
			kind: "field",
			name,
			qualifiedName: qualify(owner, name),
			startLine: node.startPosition.row + 1,
			endLine: endLine(node),
			startOffset: node.startIndex,
			endOffset: node.endIndex,
			signatureEndOffset: node.endIndex,
			visibility,
			exported: rustExported(visibility),
			children: [],
			calls: [],
			bases: [],
		});
	}
	return out;
}

function enumVariants(list: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	for (const node of list.namedChildren) {
		if (node.type !== ENUM_VARIANT) continue;
		const name = nameText(field(node, "name"));
		if (name.length === 0) continue;
		out.push({
			kind: "enumMember",
			name,
			qualifiedName: qualify(owner, name),
			startLine: node.startPosition.row + 1,
			endLine: endLine(node),
			startOffset: node.startIndex,
			endOffset: node.endIndex,
			signatureEndOffset: node.endIndex,
			visibility: "public",
			exported: true,
			children: [],
			calls: [],
			bases: [],
		});
	}
	return out;
}

function walkDeclList(
	list: Node,
	owner: string,
	source: string,
	intoImplTarget: string,
	// Trait bodies mark fn items as methods; modules keep free functions.
	methodsInOwner: boolean,
): Decl[] {
	const out: Decl[] = [];
	for (const node of list.namedChildren) {
		out.push(...declsFromItem(node, owner, source, intoImplTarget, methodsInOwner));
	}
	return out;
}

function declsFromItem(
	node: Node,
	owner: string,
	source: string,
	intoImplTarget: string,
	methodsInOwner: boolean,
): Decl[] {
	if (node.isError || node.type === "ERROR") {
		const out: Decl[] = [];
		for (const child of node.children) {
			if (child.isNamed || child.isError) {
				out.push(...declsFromItem(child, owner, source, intoImplTarget, methodsInOwner));
			}
		}
		return out;
	}

	const doc = rustDoc(node, source);
	const visibility = rustVisibility(node);

	switch (node.type) {
		case FUNCTION_ITEM:
		case FUNCTION_SIGNATURE_ITEM: {
			const name = nameText(field(node, "name"));
			const body = field(node, "body");
			// Impl methods re-home under the impl target; trait methods keep the trait owner.
			const methodOwner = intoImplTarget.length > 0 ? intoImplTarget : owner;
			const asMethod = intoImplTarget.length > 0 || methodsInOwner;
			const kind = asMethod ? "method" : "function";
			const decl = withAttrSpan(node, methodOwner, kind, name, visibility, body, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case STRUCT_ITEM:
		case UNION_ITEM: {
			// Union maps to struct — shared vocabulary has no union kind.
			const name = nameText(field(node, "name"));
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children = body !== null && body.type === FIELD_DECLARATION_LIST ? structFields(body, qn) : [];
			const decl = withAttrSpan(node, owner, "struct", name, visibility, body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case ENUM_ITEM: {
			const name = nameText(field(node, "name"));
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children = body !== null && body.type === ENUM_VARIANT_LIST ? enumVariants(body, qn) : [];
			const decl = withAttrSpan(node, owner, "enum", name, visibility, body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case TRAIT_ITEM: {
			const name = nameText(field(node, "name"));
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children =
				body !== null && body.type === DECLARATION_LIST ? walkDeclList(body, qn, source, "", true) : [];
			const decl = withAttrSpan(node, owner, "interface", name, visibility, body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case IMPL_ITEM: {
			const target = rustTypeName(field(node, "type"));
			const body = field(node, "body");
			if (body === null || body.type !== DECLARATION_LIST || target.length === 0) return [];
			const methodOwner = owner.length === 0 ? target : qualify(owner, target);
			const methods = walkDeclList(body, owner, source, methodOwner, true);
			const trait = rustTypeName(field(node, "trait"));
			// The impl block is the container its methods belong to: named for what it
			// is, so it never shadows the target type, and holding its own methods.
			const name = trait.length === 0 ? `impl ${target}` : `impl ${trait} for ${target}`;
			// An impl block carries no visibility modifier; its surface is its methods'.
			const visibility: Visibility = methods.some((method) => method.visibility === "public")
				? "public"
				: methods.some((method) => method.visibility === "internal")
					? "internal"
					: "private";
			const container = finishDecl(
				{
					kind: "class",
					name,
					qualifiedName: name,
					startLine: node.startPosition.row + 1,
					endLine: endLine(node),
					startOffset: node.startIndex,
					endOffset: node.endIndex,
					visibility,
					exported: rustExported(visibility),
					children: methods,
					// `implementations Trait` finds this impl through the trait base.
					bases: trait.length === 0 ? [] : [trait],
				},
				body,
			);
			return [applyDoc(container, doc)];
		}
		case MOD_ITEM: {
			const name = nameText(field(node, "name"));
			const body = field(node, "body");
			const qn = qualify(owner, name);
			const children =
				body !== null && body.type === DECLARATION_LIST ? walkDeclList(body, qn, source, "", false) : [];
			const decl = withAttrSpan(node, owner, "module", name, visibility, body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case CONST_ITEM:
		case STATIC_ITEM: {
			const name = nameText(field(node, "name"));
			const decl = withAttrSpan(node, owner, "constant", name, visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case TYPE_ITEM:
		case ASSOCIATED_TYPE: {
			const name = nameText(field(node, "name"));
			const decl = withAttrSpan(node, owner, "typeAlias", name, visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		default:
			return [];
	}
}

function useSpecifier(node: Node): string {
	const argument = field(node, "argument");
	return argument === null ? node.text.replace(/^use\s+/, "").replace(/;$/, "") : argument.text;
}

function collectImports(root: Node, imports: ImportRef[]): void {
	for (const node of root.namedChildren) {
		if (node.type === USE_DECLARATION) {
			imports.push({
				specifier: useSpecifier(node),
				startLine: node.startPosition.row + 1,
				startOffset: node.startIndex,
				endOffset: node.endIndex,
				bindings: [],
			});
			continue;
		}
		if (node.type === MOD_ITEM) {
			const body = field(node, "body");
			if (body !== null) {
				collectImports(body, imports);
				continue;
			}
			const name = nameText(field(node, "name"));
			if (name.length === 0) continue;
			imports.push({
				specifier: `mod ${name}`,
				startLine: node.startPosition.row + 1,
				startOffset: node.startIndex,
				endOffset: node.endIndex,
				bindings: [],
			});
		}
	}
}

function extractRust(tree: Tree, source: string): ExtractResult {
	const root = tree.rootNode;
	const decls: Decl[] = [];
	for (const node of root.children) {
		if (node.isNamed || node.isError) decls.push(...declsFromItem(node, "", source, "", false));
	}
	const imports: ImportRef[] = [];
	collectImports(root, imports);
	return { decls, imports, fileCalls: extractCalls(root) };
}

export function rustAdapter(): GrammarAdapter {
	return {
		mode: "grammar",
		id: "rust",
		extensions: EXTENSIONS,
		capabilities: CAPABILITIES,
		importNoiseIdentifiers: IMPORT_NOISE,
		extract: extractRust,
		resolveFileDep: resolveRustFileDep,
	};
}
