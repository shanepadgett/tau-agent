import type { Node, Tree } from "web-tree-sitter";
import type { ExtractResult, GrammarAdapter, LanguageCapabilities } from "../adapter.ts";
import type { Decl, ImportRef, Visibility } from "../ir.ts";
import {
	applyDoc,
	declFromNode,
	docSpanBefore,
	endLine,
	field,
	finishDecl,
	nameText,
	qualify,
	startLine,
	unquote,
	type DocSpan,
} from "./tree.ts";

const CAPABILITIES: LanguageCapabilities = {
	shape: true,
	search: true,
	fileDeps: true,
	callEdges: true,
	packageSurface: true,
};

const TS_EXTENSIONS = [".ts", ".mts", ".cts"] as const;
const TSX_EXTENSIONS = [".tsx", ".mtsx"] as const;

// Node-type constants — owned by this adapter.
const DECORATOR = "decorator";
const EXPORT_STATEMENT = "export_statement";
const IMPORT_STATEMENT = "import_statement";
const FUNCTION_DECLARATION = "function_declaration";
const FUNCTION_EXPRESSION = "function_expression";
const FUNCTION_SIGNATURE = "function_signature";
const GENERATOR_FUNCTION_DECLARATION = "generator_function_declaration";
const CLASS_DECLARATION = "class_declaration";
const ABSTRACT_CLASS_DECLARATION = "abstract_class_declaration";
const CLASS = "class";
const INTERFACE_DECLARATION = "interface_declaration";
const TYPE_ALIAS_DECLARATION = "type_alias_declaration";
const ENUM_DECLARATION = "enum_declaration";
const LEXICAL_DECLARATION = "lexical_declaration";
const VARIABLE_DECLARATION = "variable_declaration";
const VARIABLE_DECLARATOR = "variable_declarator";
const INTERNAL_MODULE = "internal_module";
const MODULE = "module";
const AMBIENT_DECLARATION = "ambient_declaration";
const EXPRESSION_STATEMENT = "expression_statement";
const METHOD_DEFINITION = "method_definition";
const PUBLIC_FIELD_DEFINITION = "public_field_definition";
const ABSTRACT_METHOD_SIGNATURE = "abstract_method_signature";
const METHOD_SIGNATURE = "method_signature";
const PROPERTY_SIGNATURE = "property_signature";
const ARROW_FUNCTION = "arrow_function";
const ACCESSIBILITY_MODIFIER = "accessibility_modifier";
const PRIVATE_PROPERTY_IDENTIFIER = "private_property_identifier";
const PROPERTY_IDENTIFIER = "property_identifier";
const ENUM_ASSIGNMENT = "enum_assignment";
const COMMENT = "comment";

function tsDoc(node: Node, source: string): DocSpan | undefined {
	return docSpanBefore(node, source, [DECORATOR]);
}

function visibilityOf(node: Node): Visibility {
	for (const child of node.namedChildren) {
		if (child.type === ACCESSIBILITY_MODIFIER) {
			const text = child.text;
			if (text === "private" || text === "protected" || text === "public") return text;
		}
	}
	const name = field(node, "name");
	if (name !== null && name.type === PRIVATE_PROPERTY_IDENTIFIER) return "private";
	return "public";
}

function valueIsFunction(value: Node | null): boolean {
	if (value === null) return false;
	return (
		value.type === ARROW_FUNCTION ||
		value.type === FUNCTION_EXPRESSION ||
		value.type === FUNCTION_DECLARATION ||
		value.type === GENERATOR_FUNCTION_DECLARATION
	);
}

function walkStatementList(nodes: readonly Node[], owner: string, source: string, exportedDefault: boolean): Decl[] {
	const decls: Decl[] = [];
	for (const node of nodes) {
		decls.push(...declsFromStatement(node, owner, source, exportedDefault));
	}
	return decls;
}

function asList(decl: Decl | undefined): Decl[] {
	return decl === undefined ? [] : [decl];
}

function declsFromStatement(node: Node, owner: string, source: string, parentExported: boolean): Decl[] {
	// ERROR recovery: keep walking recognizable decls nested under broken nodes.
	if (node.isError || node.type === "ERROR") {
		const out: Decl[] = [];
		for (const child of node.children) {
			if (child.isNamed || child.isError) {
				out.push(...declsFromStatement(child, owner, source, parentExported));
			}
		}
		return out;
	}
	if (node.type === EXPRESSION_STATEMENT) {
		const out: Decl[] = [];
		for (const child of node.children) {
			if (child.isNamed || child.isError) {
				out.push(...declsFromStatement(child, owner, source, parentExported));
			}
		}
		return out;
	}
	if (node.type === EXPORT_STATEMENT) {
		return declsFromExport(node, owner, source);
	}
	if (node.type === AMBIENT_DECLARATION) {
		const inner = node.namedChildren.find((child) => child.type !== COMMENT);
		if (inner === undefined) return [];
		const doc = tsDoc(node, source);
		return declsFromStatement(inner, owner, source, parentExported).map((decl, index) =>
			index === 0 ? applyDoc(decl, doc) : decl,
		);
	}
	if (node.type === IMPORT_STATEMENT) return [];

	const doc = tsDoc(node, source);

	switch (node.type) {
		case FUNCTION_DECLARATION:
		case GENERATOR_FUNCTION_DECLARATION:
		case FUNCTION_SIGNATURE: {
			const name = nameText(field(node, "name")) || "default";
			return asList(declFromNode(node, owner, "function", name, parentExported, field(node, "body"), [], doc));
		}
		case CLASS_DECLARATION:
		case ABSTRACT_CLASS_DECLARATION:
		case CLASS: {
			const name = nameText(field(node, "name")) || (parentExported ? "default" : "");
			const body = field(node, "body");
			const children = body === null ? [] : classMembers(body, qualify(owner, name), source);
			return asList(declFromNode(node, owner, "class", name, parentExported, body, children, doc));
		}
		case INTERFACE_DECLARATION: {
			// Judgment: TS type aliases also map to interface; this is the real interface kind.
			const name = nameText(field(node, "name"));
			const body = field(node, "body");
			const children = body === null ? [] : interfaceMembers(body, qualify(owner, name), source);
			return asList(declFromNode(node, owner, "interface", name, parentExported, body, children, doc));
		}
		case TYPE_ALIAS_DECLARATION: {
			const name = nameText(field(node, "name"));
			return asList(declFromNode(node, owner, "typeAlias", name, parentExported, null, [], doc));
		}
		case ENUM_DECLARATION: {
			const name = nameText(field(node, "name"));
			const body = field(node, "body");
			const children = body === null ? [] : enumMembers(body, qualify(owner, name));
			return asList(declFromNode(node, owner, "enum", name, parentExported, body, children, doc));
		}
		case LEXICAL_DECLARATION:
		case VARIABLE_DECLARATION:
			return variableDecls(node, owner, parentExported, doc);
		case INTERNAL_MODULE:
		case MODULE: {
			const nameNode = field(node, "name");
			const name = nameNode === null ? "" : unquote(nameNode.text);
			const body = field(node, "body");
			const children =
				body === null ? [] : walkStatementList(body.namedChildren, qualify(owner, name), source, false);
			const kind = node.type === INTERNAL_MODULE ? "namespace" : "module";
			return asList(declFromNode(node, owner, kind, name, parentExported, body, children, doc));
		}
		default:
			return [];
	}
}

function declsFromExport(node: Node, owner: string, source: string): Decl[] {
	const doc = tsDoc(node, source);
	const declaration = field(node, "declaration");
	const value = field(node, "value");
	const isDefault = node.children.some((child) => child.type === "default");

	if (declaration !== null) {
		// export declare … arrives as ambient_declaration under declaration field.
		const decls = declsFromStatement(declaration, owner, source, true);
		if (isDefault) {
			for (const decl of decls) {
				if (decl.name.length === 0) decl.name = "default";
				decl.exported = true;
				decl.qualifiedName = qualify(owner, decl.name);
			}
		}
		if (decls[0] !== undefined) decls[0] = applyDoc(decls[0], doc);
		// Re-span so line/byte range covers the `export` keyword.
		for (const decl of decls) {
			decl.startByte = node.startIndex;
			decl.endByte = node.endIndex;
			decl.startLine = startLine(node);
			decl.endLine = endLine(node);
			if (decl.bodyStartByte === undefined) decl.signatureEndByte = node.endIndex;
		}
		return decls;
	}

	if (value !== null) {
		// export default function() {} / class {} / expression
		let name = "default";
		let kind: Decl["kind"] = "variable";
		let body: Node | null = null;
		let children: Decl[] = [];

		if (
			value.type === FUNCTION_EXPRESSION ||
			value.type === FUNCTION_DECLARATION ||
			value.type === GENERATOR_FUNCTION_DECLARATION ||
			value.type === ARROW_FUNCTION
		) {
			const named = nameText(field(value, "name"));
			name = named.length > 0 ? named : "default";
			kind = "function";
			body = field(value, "body");
		} else if (value.type === CLASS || value.type === CLASS_DECLARATION) {
			const named = nameText(field(value, "name"));
			name = named.length > 0 ? named : "default";
			kind = "class";
			body = field(value, "body");
			children = body === null ? [] : classMembers(body, qualify(owner, name), source);
		}

		const decl = finishDecl(
			{
				kind,
				name,
				qualifiedName: qualify(owner, name),
				startLine: startLine(node),
				endLine: endLine(node),
				startByte: node.startIndex,
				endByte: node.endIndex,
				visibility: "public",
				exported: true,
				children,
			},
			body,
		);
		if (body === null) decl.signatureEndByte = node.endIndex;
		return [applyDoc(decl, doc)];
	}

	return [];
}

function variableDecls(node: Node, owner: string, exported: boolean, doc: DocSpan | undefined): Decl[] {
	const kindKeyword = node.type === LEXICAL_DECLARATION ? (field(node, "kind")?.text ?? "let") : "var";
	const declarators = node.namedChildren.filter((child) => child.type === VARIABLE_DECLARATOR);
	const multi = declarators.length > 1;
	const out: Decl[] = [];

	for (let i = 0; i < declarators.length; i += 1) {
		const declarator = declarators[i];
		if (declarator === undefined) continue;
		const name = nameText(field(declarator, "name"));
		if (name.length === 0) continue;
		const value = field(declarator, "value");
		const isFn = valueIsFunction(value);
		const isConst = kindKeyword === "const";
		let kind: Decl["kind"] = isFn ? "function" : isConst ? "constant" : "variable";
		if (!isFn && value !== null && value.type === "object") kind = "object";

		const spanNode = multi ? declarator : node;
		const body = isFn && value !== null ? field(value, "body") : null;
		const decl = finishDecl(
			{
				kind,
				name,
				qualifiedName: qualify(owner, name),
				startLine: startLine(spanNode),
				endLine: endLine(spanNode),
				startByte: spanNode.startIndex,
				endByte: spanNode.endIndex,
				visibility: "public",
				exported,
			},
			body,
		);
		if (body === null) decl.signatureEndByte = spanNode.endIndex;
		out.push(i === 0 ? applyDoc(decl, doc) : decl);
	}
	return out;
}

function memberDecl(
	node: Node,
	owner: string,
	kind: Decl["kind"],
	name: string,
	body: Node | null,
	doc: DocSpan | undefined,
	visibility: Visibility = "public",
): Decl | undefined {
	if (name.length === 0) return undefined;
	const decl = finishDecl(
		{
			kind,
			name,
			qualifiedName: qualify(owner, name),
			startLine: startLine(node),
			endLine: endLine(node),
			startByte: node.startIndex,
			endByte: node.endIndex,
			visibility,
			exported: false,
		},
		body,
	);
	if (body === null) decl.signatureEndByte = node.endIndex;
	return applyDoc(decl, doc);
}

function classMembers(body: Node, owner: string, source: string): Decl[] {
	const out: Decl[] = [];
	for (const node of body.namedChildren) {
		const doc = tsDoc(node, source);
		if (node.type === METHOD_DEFINITION) {
			const rawName = nameText(field(node, "name"));
			const name = rawName.length === 0 ? "" : unquote(rawName);
			const kind = name === "constructor" ? "constructor" : "method";
			const decl = memberDecl(node, owner, kind, name, field(node, "body"), doc, visibilityOf(node));
			if (decl !== undefined) out.push(decl);
			continue;
		}
		if (node.type === PUBLIC_FIELD_DEFINITION) {
			const name = nameText(field(node, "name"));
			const value = field(node, "value");
			const isFn = valueIsFunction(value);
			const decl = memberDecl(
				node,
				owner,
				isFn ? "method" : "field",
				name,
				isFn && value !== null ? field(value, "body") : null,
				doc,
				visibilityOf(node),
			);
			if (decl !== undefined) out.push(decl);
			continue;
		}
		if (node.type === ABSTRACT_METHOD_SIGNATURE || node.type === METHOD_SIGNATURE) {
			const name = nameText(field(node, "name"));
			const decl = memberDecl(node, owner, "method", name, null, doc, visibilityOf(node));
			if (decl !== undefined) out.push(decl);
		}
	}
	return out;
}

function interfaceMembers(body: Node, owner: string, source: string): Decl[] {
	const out: Decl[] = [];
	for (const node of body.namedChildren) {
		const doc = tsDoc(node, source);
		if (node.type === METHOD_SIGNATURE) {
			const decl = memberDecl(node, owner, "method", nameText(field(node, "name")), null, doc);
			if (decl !== undefined) out.push(decl);
			continue;
		}
		if (node.type === PROPERTY_SIGNATURE) {
			const decl = memberDecl(node, owner, "property", nameText(field(node, "name")), null, doc);
			if (decl !== undefined) out.push(decl);
		}
	}
	return out;
}

function enumMembers(body: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	for (const node of body.namedChildren) {
		if (node.type === PROPERTY_IDENTIFIER) {
			const decl = memberDecl(node, owner, "enumMember", node.text, null, undefined);
			if (decl !== undefined) out.push(decl);
			continue;
		}
		if (node.type === ENUM_ASSIGNMENT) {
			const nameNode = node.namedChildren[0];
			if (nameNode === undefined) continue;
			const decl = memberDecl(node, owner, "enumMember", nameNode.text, null, undefined);
			if (decl !== undefined) out.push(decl);
		}
	}
	return out;
}

function collectImportsFrom(node: Node, imports: ImportRef[]): void {
	for (const child of node.namedChildren) {
		if (child.type === IMPORT_STATEMENT) {
			const source = field(child, "source");
			if (source !== null) {
				imports.push({
					specifier: unquote(source.text),
					startLine: startLine(child),
					startByte: child.startIndex,
					endByte: child.endIndex,
				});
			}
			continue;
		}
		if (child.type === EXPRESSION_STATEMENT || child.type === AMBIENT_DECLARATION) {
			collectImportsFrom(child, imports);
			continue;
		}
		if (child.type === MODULE || child.type === INTERNAL_MODULE) {
			const body = field(child, "body");
			if (body !== null) collectImportsFrom(body, imports);
		}
	}
}

function extractTypeScript(tree: Tree, source: string): ExtractResult {
	const root = tree.rootNode;
	// Include ERROR siblings so degraded parses still yield surrounding decls.
	const top = root.children.filter((child) => child.isNamed || child.isError);
	const decls = walkStatementList(top, "", source, false);
	const imports: ImportRef[] = [];
	collectImportsFrom(root, imports);
	return { decls, imports };
}

function makeAdapter(id: "typescript" | "tsx", extensions: readonly string[]): GrammarAdapter {
	return {
		mode: "grammar",
		id,
		extensions,
		capabilities: CAPABILITIES,
		extract: extractTypeScript,
	};
}

export function typescriptAdapter(): GrammarAdapter {
	return makeAdapter("typescript", TS_EXTENSIONS);
}

export function tsxAdapter(): GrammarAdapter {
	return makeAdapter("tsx", TSX_EXTENSIONS);
}
