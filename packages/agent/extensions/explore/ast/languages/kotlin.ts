import type { Node, Tree } from "web-tree-sitter";
import type { ExtractResult, GrammarAdapter, LanguageCapabilities } from "../adapter.ts";
import { resolveKotlinFileDep } from "./jvm-file-deps.ts";
import type { Decl, ImportRef, Visibility } from "../ir.ts";
import {
	applyDoc,
	docSpanBefore,
	docSpanTrailingChild,
	endLine,
	finishDecl,
	nameText,
	qualify,
	startLine,
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
	"as",
	"break",
	"class",
	"continue",
	"do",
	"else",
	"false",
	"for",
	"fun",
	"if",
	"in",
	"interface",
	"is",
	"null",
	"object",
	"package",
	"return",
	"super",
	"this",
	"throw",
	"true",
	"try",
	"typealias",
	"typeof",
	"val",
	"var",
	"when",
	"while",
	"by",
	"catch",
	"constructor",
	"delegate",
	"dynamic",
	"field",
	"file",
	"finally",
	"get",
	"import",
	"init",
	"param",
	"property",
	"receiver",
	"set",
	"setparam",
	"where",
	"actual",
	"abstract",
	"annotation",
	"companion",
	"const",
	"crossinline",
	"data",
	"enum",
	"expect",
	"external",
	"final",
	"infix",
	"inline",
	"inner",
	"internal",
	"lateinit",
	"noinline",
	"open",
	"operator",
	"out",
	"override",
	"private",
	"protected",
	"public",
	"reified",
	"sealed",
	"suspend",
	"tailrec",
	"vararg",
]);

const EXTENSIONS = [".kt", ".ktm", ".kts"] as const;

// Node names from fwcd/tree-sitter-kotlin — do not assume Java grammar names.
const CLASS_DECLARATION = "class_declaration";
const OBJECT_DECLARATION = "object_declaration";
const FUNCTION_DECLARATION = "function_declaration";
const PROPERTY_DECLARATION = "property_declaration";
const TYPE_ALIAS = "type_alias";
const COMPANION_OBJECT = "companion_object";
const SECONDARY_CONSTRUCTOR = "secondary_constructor";
const CLASS_BODY = "class_body";
const ENUM_CLASS_BODY = "enum_class_body";
const ENUM_ENTRY = "enum_entry";
const PRIMARY_CONSTRUCTOR = "primary_constructor";
const CLASS_PARAMETER = "class_parameter";
const MODIFIERS = "modifiers";
const VISIBILITY_MODIFIER = "visibility_modifier";
const PROPERTY_MODIFIER = "property_modifier";
const TYPE_IDENTIFIER = "type_identifier";
const SIMPLE_IDENTIFIER = "simple_identifier";
const VARIABLE_DECLARATION = "variable_declaration";
const FUNCTION_BODY = "function_body";
const PACKAGE_HEADER = "package_header";
const IMPORT_LIST = "import_list";
const IMPORT_HEADER = "import_header";
const LINE_COMMENT = "line_comment";
const MULTILINE_COMMENT = "multiline_comment";

const COMMENT_TYPES = [LINE_COMMENT, MULTILINE_COMMENT] as const;

function previousNamed(node: Node): Node | null {
	let cursor = node.previousSibling;
	while (cursor !== null && !cursor.isNamed) cursor = cursor.previousSibling;
	return cursor;
}

/**
 * KDoc often attaches as a trailing child of package_header / import_header instead of a sibling.
 */
function kotlinDoc(node: Node, source: string): DocSpan | undefined {
	const direct = docSpanBefore(node, source, [], COMMENT_TYPES);
	if (direct !== undefined) return direct;

	const prev = previousNamed(node);
	if (prev === null) return undefined;
	if (prev.type === PACKAGE_HEADER) {
		return docSpanTrailingChild(prev, node, source, COMMENT_TYPES);
	}
	if (prev.type === IMPORT_LIST) {
		const onList = docSpanTrailingChild(prev, node, source, COMMENT_TYPES);
		if (onList !== undefined) return onList;
		const headers = prev.namedChildren.filter((child) => child.type === IMPORT_HEADER);
		const last = headers[headers.length - 1];
		if (last !== undefined) return docSpanTrailingChild(last, node, source, COMMENT_TYPES);
	}
	return undefined;
}

function visibilityOf(node: Node): Visibility {
	const mods = node.namedChildren.find((child) => child.type === MODIFIERS);
	if (mods === undefined) return "public";
	for (const child of mods.namedChildren) {
		if (child.type !== VISIBILITY_MODIFIER) continue;
		const text = child.text;
		if (text === "public" || text === "private" || text === "protected" || text === "internal") return text;
	}
	return "public";
}

function isConstProperty(node: Node): boolean {
	const mods = node.namedChildren.find((child) => child.type === MODIFIERS);
	if (mods === undefined) return false;
	return mods.namedChildren.some((child) => child.type === PROPERTY_MODIFIER && child.text === "const");
}

function typeIdentifierName(node: Node): string {
	const direct = node.namedChildren.find((child) => child.type === TYPE_IDENTIFIER);
	return direct === undefined ? "" : direct.text;
}

function simpleName(node: Node | null): string {
	if (node === null) return "";
	if (node.type === SIMPLE_IDENTIFIER) return node.text;
	const inner = node.namedChildren.find((child) => child.type === SIMPLE_IDENTIFIER);
	return inner === undefined ? nameText(node) : inner.text;
}

function classKind(node: Node): Decl["kind"] {
	// Keywords are anonymous children: interface / enum / class.
	let hasEnum = false;
	let hasInterface = false;
	for (const child of node.children) {
		if (child.type === "enum") hasEnum = true;
		if (child.type === "interface") hasInterface = true;
	}
	if (hasEnum) return "enum";
	if (hasInterface) return "interface";
	return "class";
}

function functionBody(node: Node): Node | null {
	const body = node.namedChildren.find((child) => child.type === FUNCTION_BODY);
	return body ?? null;
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
			exported: visibility === "public" || visibility === "internal",
			children,
		},
		body,
	);
	if (body === null) decl.signatureEndOffset = node.endIndex;
	return applyDoc(decl, doc);
}

function primaryConstructorProperties(ctor: Node, owner: string): Decl[] {
	const out: Decl[] = [];
	for (const node of ctor.namedChildren) {
		if (node.type !== CLASS_PARAMETER) continue;
		// Only val/var parameters become properties.
		const hasBinding = node.children.some((child) => child.type === "binding_pattern_kind");
		if (!hasBinding) continue;
		const name = simpleName(node.namedChildren.find((child) => child.type === SIMPLE_IDENTIFIER) ?? null);
		const decl = leaf(node, owner, "property", name, visibilityOf(node), null, [], undefined);
		if (decl !== undefined) out.push(decl);
	}
	return out;
}

function propertyName(node: Node): string {
	const variable = node.namedChildren.find((child) => child.type === VARIABLE_DECLARATION);
	if (variable === undefined) return "";
	return simpleName(variable.namedChildren.find((child) => child.type === SIMPLE_IDENTIFIER) ?? null);
}

function walkClassBody(body: Node, owner: string, source: string): Decl[] {
	const out: Decl[] = [];
	for (const node of body.namedChildren) {
		if (node.type === LINE_COMMENT || node.type === MULTILINE_COMMENT) continue;
		if (node.type === ENUM_ENTRY) {
			const name = simpleName(node.namedChildren.find((child) => child.type === SIMPLE_IDENTIFIER) ?? null);
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

	const doc = kotlinDoc(node, source);
	const visibility = visibilityOf(node);

	switch (node.type) {
		case CLASS_DECLARATION: {
			const name = typeIdentifierName(node);
			const kind = classKind(node);
			const qn = qualify(owner, name);
			const children: Decl[] = [];
			const primary = node.namedChildren.find((child) => child.type === PRIMARY_CONSTRUCTOR);
			if (primary !== undefined) children.push(...primaryConstructorProperties(primary, qn));
			const body =
				node.namedChildren.find((child) => child.type === CLASS_BODY || child.type === ENUM_CLASS_BODY) ?? null;
			if (body !== null) children.push(...walkClassBody(body, qn, source));
			const decl = leaf(node, owner, kind, name, visibility, body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case OBJECT_DECLARATION: {
			const name = typeIdentifierName(node);
			const body = node.namedChildren.find((child) => child.type === CLASS_BODY) ?? null;
			const qn = qualify(owner, name);
			const children = body === null ? [] : walkClassBody(body, qn, source);
			const decl = leaf(node, owner, "object", name, visibility, body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case COMPANION_OBJECT: {
			// Nest under owner; use explicit name or "Companion".
			const named = typeIdentifierName(node);
			const name = named.length > 0 ? named : "Companion";
			const body = node.namedChildren.find((child) => child.type === CLASS_BODY) ?? null;
			const qn = qualify(owner, name);
			const children = body === null ? [] : walkClassBody(body, qn, source);
			const decl = leaf(node, owner, "object", name, visibility, body, children, doc);
			return decl === undefined ? [] : [decl];
		}
		case FUNCTION_DECLARATION: {
			const name = simpleName(node.namedChildren.find((child) => child.type === SIMPLE_IDENTIFIER) ?? null);
			const body = functionBody(node);
			const kind = owner.length > 0 ? "method" : "function";
			const decl = leaf(node, owner, kind, name, visibility, body, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case SECONDARY_CONSTRUCTOR: {
			const decl = leaf(node, owner, "constructor", "constructor", visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case PROPERTY_DECLARATION: {
			const name = propertyName(node);
			const kind = isConstProperty(node) ? "constant" : "property";
			const getter = node.namedChildren.find((child) => child.type === "getter");
			const body = getter === undefined ? null : (functionBody(getter) ?? getter);
			const decl = leaf(node, owner, kind, name, visibility, body, [], doc);
			return decl === undefined ? [] : [decl];
		}
		case TYPE_ALIAS: {
			const name = typeIdentifierName(node);
			const decl = leaf(node, owner, "typeAlias", name, visibility, null, [], doc);
			return decl === undefined ? [] : [decl];
		}
		default:
			// fwcd/tree-sitter-kotlin#75: newline / actual primary ctor splits class from body.
			// Body lands as call_expression / comparison_expression + lambda; walk those only.
			if (node.type === "infix_expression") {
				const companion = companionFromMisparsedInfix(node, owner, source);
				if (companion !== undefined) return [companion];
			}
			if (RECOVERY_CONTAINERS.has(node.type)) {
				const out: Decl[] = [];
				for (const child of node.namedChildren) {
					out.push(...declsFromNode(child, owner, source));
				}
				return out;
			}
			return [];
	}
}

/**
 * When class body fails to attach (fwcd/tree-sitter-kotlin#75 ASI split), companion forms as:
 *   A) companion object { } → infix(simple_identifier companion, simple_identifier object, lambda_literal)
 *   B) actual companion object { } → infix(..., companion, object_literal)  // "object" inside object_literal
 * Observed on okio ByteString expect/actual variants.
 */
function companionFromMisparsedInfix(node: Node, owner: string, source: string): Decl | undefined {
	const named = node.namedChildren;
	let companionIdx = -1;
	for (let i = 0; i < named.length; i += 1) {
		const child = named[i];
		if (child !== undefined && child.type === SIMPLE_IDENTIFIER && child.text === "companion") {
			companionIdx = i;
			break;
		}
	}
	if (companionIdx < 0) return undefined;
	const after = named[companionIdx + 1];
	if (after === undefined) return undefined;

	let body: Node | null = null;
	let memberRoot: Node | null = null;

	if (after.type === SIMPLE_IDENTIFIER && after.text === "object") {
		const bodyNode = named[companionIdx + 2];
		if (bodyNode === undefined) return undefined;
		if (bodyNode.type === "lambda_literal") {
			body = bodyNode;
			memberRoot = bodyNode.namedChildren.find((child) => child.type === "statements") ?? null;
		} else if (bodyNode.type === "annotated_lambda") {
			const lambda = bodyNode.namedChildren.find((child) => child.type === "lambda_literal");
			if (lambda === undefined) return undefined;
			body = lambda;
			memberRoot = lambda.namedChildren.find((child) => child.type === "statements") ?? null;
		} else {
			return undefined;
		}
	} else if (after.type === "object_literal") {
		body = after;
		memberRoot = after.namedChildren.find((child) => child.type === CLASS_BODY) ?? null;
	} else {
		return undefined;
	}

	const name = "Companion";
	const qn = qualify(owner, name);
	const children =
		memberRoot === null
			? []
			: memberRoot.type === CLASS_BODY
				? walkClassBody(memberRoot, qn, source)
				: memberRoot.namedChildren.flatMap((child) => declsFromNode(child, qn, source));
	return leaf(node, owner, "object", name, visibilityOf(node), body, children, kotlinDoc(node, source));
}

/** Recovery containers only — not a general expression walk. */
const RECOVERY_CONTAINERS = new Set([
	"comparison_expression",
	"lambda_literal",
	"annotated_lambda",
	"statements",
	"call_expression",
	"call_suffix",
	"annotated_expression",
	"prefix_expression",
	// infix_expression handled above for companion; still walk other infixes for nested decls.
	"infix_expression",
]);

const TYPE_KINDS = new Set<Decl["kind"]>(["class", "interface", "object", "enum", "struct"]);

function requalify(decl: Decl, owner: string): Decl {
	const qualifiedName = qualify(owner, decl.name);
	const kind =
		decl.kind === "function" && owner.length > 0
			? "method"
			: decl.kind === "method" && owner.length === 0
				? "function"
				: decl.kind;
	return {
		...decl,
		kind,
		qualifiedName,
		children: decl.children.map((child) => requalify(child, qualifiedName)),
	};
}

function isRehomeBarrier(decl: Decl): boolean {
	if (decl.kind === "typeAlias") return true;
	// Misparsed companion becomes a top-level object; still absorb into the empty class.
	if (decl.kind === "object" && decl.name === "Companion") return false;
	return TYPE_KINDS.has(decl.kind);
}

/**
 * When expect/actual class body fails to attach (fwcd#75), members land as following top-level decls.
 * Fold free functions/properties/Companion into the preceding empty type until the next real type.
 */
function rehomeOrphanMembers(decls: Decl[]): Decl[] {
	const out: Decl[] = [];
	for (let i = 0; i < decls.length; i += 1) {
		const decl = decls[i];
		if (decl === undefined) continue;
		if (!TYPE_KINDS.has(decl.kind) || decl.children.length > 0) {
			out.push(decl);
			continue;
		}
		const members: Decl[] = [];
		let j = i + 1;
		while (j < decls.length) {
			const next = decls[j];
			if (next === undefined || isRehomeBarrier(next)) break;
			members.push(requalify(next, decl.qualifiedName));
			j += 1;
		}
		if (members.length === 0) {
			out.push(decl);
			continue;
		}
		const last = members[members.length - 1];
		out.push({
			...decl,
			children: members,
			endLine: last === undefined ? decl.endLine : last.endLine,
			endOffset: last === undefined ? decl.endOffset : last.endOffset,
		});
		i = j - 1;
	}
	return out;
}

function collectImports(root: Node): ImportRef[] {
	const imports: ImportRef[] = [];
	for (const node of root.namedChildren) {
		if (node.type !== IMPORT_LIST) continue;
		for (const header of node.namedChildren) {
			if (header.type !== IMPORT_HEADER) continue;
			const id = header.namedChildren.find((child) => child.type === "identifier");
			const specifier = id === undefined ? header.text.replace(/^import\s+/, "").trim() : id.text;
			imports.push({
				specifier,
				startLine: startLine(header),
				startOffset: header.startIndex,
				endOffset: header.endIndex,
			});
		}
	}
	return imports;
}

function extractKotlin(tree: Tree, source: string): ExtractResult {
	const root = tree.rootNode;
	const decls: Decl[] = [];
	for (const node of root.children) {
		if (node.isNamed || node.isError) decls.push(...declsFromNode(node, "", source));
	}
	return { decls: rehomeOrphanMembers(decls), imports: collectImports(root) };
}

export function kotlinAdapter(): GrammarAdapter {
	return {
		mode: "grammar",
		id: "kotlin",
		extensions: EXTENSIONS,
		capabilities: CAPABILITIES,
		importNoiseIdentifiers: IMPORT_NOISE,
		extract: extractKotlin,
		resolveFileDep: resolveKotlinFileDep,
	};
}
