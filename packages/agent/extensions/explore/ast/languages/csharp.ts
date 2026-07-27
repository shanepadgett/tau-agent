import type { Node, Tree } from "web-tree-sitter";
import type { ExtractResult, GrammarAdapter, LanguageCapabilities } from "../adapter.ts";
import type { Decl, ImportRef, Visibility } from "../ir.ts";
import {
	applyDoc,
	docSpanBefore,
	endLine,
	field,
	finishDecl,
	nameText,
	qualify,
	startLine,
	type DocSpan,
} from "./tree.ts";

const CAPABILITIES: LanguageCapabilities = {
	shape: true,
	search: true,
	fileDeps: false,
	callEdges: true,
	packageSurface: false,
};

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
		// using X; / using static X; — take full directive text minus keyword noise via child names.
		const nameNode =
			node.namedChildren.find((child) => child.type === "identifier" || child.type === "qualified_name") ?? null;
		const specifier = nameNode === null ? node.text.replace(/^using\s+/, "").replace(/;$/, "") : nameNode.text;
		imports.push({
			specifier,
			startLine: startLine(node),
			startOffset: node.startIndex,
			endOffset: node.endIndex,
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

	return { decls, imports: collectImports(root) };
}

export function csharpAdapter(): GrammarAdapter {
	return {
		mode: "grammar",
		id: "c_sharp",
		extensions: EXTENSIONS,
		capabilities: CAPABILITIES,
		extract: extractCsharp,
	};
}
