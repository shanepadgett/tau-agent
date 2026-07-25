import { resolve } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAstTools } from "../../../extensions/explore/ast-tools.ts";
import type { AstClient, OutlineTargetResult, SymbolBatchResult } from "../../../extensions/explore/ast-worker.ts";
import {
	createWorkspace,
	extensionContext,
	firstText,
	renderContext,
	renderedText,
	testTheme,
	type Workspace,
	testRowState,
} from "./helpers.ts";

const range = {
	startByte: 0,
	endByte: 28,
	start: { line: 0, column: 0 },
	end: { line: 2, column: 1 },
};

function outlineResult(path: string): OutlineTargetResult {
	return {
		path,
		totalByteLength: 200,
		totalLineCount: 10,
		files: [
			{
				path,
				language: "typeScript",
				sourceFingerprint: "blake3:test",
				byteLength: 200,
				lineCount: 10,
				diagnostics: { errorNodes: 0, missingNodes: 0 },
				items: [
					{
						rowKind: "declaration",
						role: "item",
						symbolType: "function",
						name: "parse",
						qualifiedName: "parse",
						range,
						nameRange: range,
						signature: "function parse(): void",
						astKind: "function_declaration",
						certainty: "certain",
						locator: "native-locator",
						isImport: false,
						isExported: true,
						members: [],
					},
				],
			},
		],
	};
}

describe("AST exploration tools", () => {
	let workspace: Workspace;
	beforeAll(() => initTheme());

	beforeEach(async () => {
		workspace = await createWorkspace();
		await workspace.write("src/parser.ts", "function parse(): void {}\n");
	});

	afterEach(async () => workspace.cleanup());

	it("outlines files and resolves short locators as one exact symbol batch", async () => {
		const path = workspace.path("src/parser.ts");
		const source = "function parse(): void {}";
		const symbolResult: SymbolBatchResult = {
			declarations: [
				{
					locator: "native-locator",
					path,
					language: "typeScript",
					sourceFingerprint: "blake3:test",
					declarationRange: range,
				},
			],
			blocks: [{ path, returnedRange: range, declarationIndexes: [0], source }],
		};
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async (target, includePrivate, includeDocs, names) => {
				expect(target).toEqual({ kind: "file", path, language: "typeScript" });
				expect(includePrivate).toBe(false);
				expect(includeDocs).toBe(false);
				expect(names).toEqual([]);
				return outlineResult(path);
			}),
			symbol: vi.fn(async (locators, view, contextLines) => {
				expect(locators).toEqual(["native-locator"]);
				expect(view).toBe("declaration");
				expect(contextLines).toBe(2);
				return symbolResult;
			}),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);

		const outlined = await ast.outline.execute(
			"outline-1",
			{ path: "@src/parser.ts" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		expect(firstText(outlined)).toContain("declarations\n1-3(1): function parse(): void");
		expect(firstText(outlined)).not.toContain("parser.ts (typeScript");

		const symbolArgs = { locators: [1], view: "declaration" as const, contextLines: 2 };
		const symbolCall = ast.symbol.renderCall?.(symbolArgs, testTheme, renderContext(symbolArgs, false));
		const symbolCallLine = symbolCall?.render(200).join("\n") ?? "";
		expect(symbolCallLine).toContain("symbol");
		expect(symbolCallLine).toContain("parser.ts: parse");
		expect(symbolCallLine).toContain("[declaration context=2]");
		expect(symbolCallLine).not.toContain("ast:");

		const symbol = await ast.symbol.execute(
			"symbol-1",
			symbolArgs,
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		expect(firstText(symbol)).toContain("1-3(1): parse");
		expect(firstText(symbol)).toContain(source);
		expect(firstText(symbol)).not.toContain("parser.ts");
	});

	it("sends directories and public-surface options to the worker", async () => {
		await workspace.mkdir("src/package");
		const path = workspace.path("src/package");
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => ({ path, files: [], totalByteLength: 0, totalLineCount: 0 })),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const result = await ast.outline.execute(
			"outline-1",
			{ path: "src/package", includePrivate: true, names: ["Foo", "bar"] },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);

		expect(client.outline).toHaveBeenCalledWith({ kind: "directory", path }, true, false, ["Foo", "bar"], undefined);
		expect(firstText(result)).toContain("No matching declarations");
	});

	it("does not expose a disconnected body-only symbol view", () => {
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const schema = ast.symbol.parameters as unknown as {
			properties?: { view?: { enum?: string[] } };
		};
		expect(schema.properties?.view?.enum).toEqual(["signature", "declaration", "declarationWithImports"]);
	});

	it("exposes documentation as an opt-in outline parameter and call-row option", async () => {
		const path = workspace.path("src/parser.ts");
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => outlineResult(path)),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const schema = ast.outline.parameters as unknown as {
			properties?: { includeDocs?: { type?: string; description?: string } };
		};
		expect(schema.properties?.includeDocs?.type).toBe("boolean");
		expect(schema.properties?.includeDocs?.description).toContain("documentation comments");

		const args = { path: "src/parser.ts", includeDocs: true };
		const call = ast.outline.renderCall?.(args, testTheme, renderContext(args, false));
		expect(call?.render(200).join("\n")).toContain("[docs]");
		await ast.outline.execute("outline-docs", args, undefined, undefined, extensionContext(workspace.dir));
		expect(client.outline).toHaveBeenCalledWith(
			{ kind: "file", path, language: "typeScript" },
			false,
			true,
			[],
			undefined,
		);
	});

	it("renders source-order TypeScript structure without fake locators", async () => {
		const path = workspace.path("src/parser.ts");
		const result = outlineResult(path);
		const declaration = result.files[0]?.items[0];
		if (!declaration) throw new Error("outline fixture omitted its declaration");
		const { locator: _locator, ...structuralEntry } = declaration;
		result.files[0]?.items.unshift({
			...structuralEntry,
			rowKind: "import",
			name: '"./types.ts"',
			qualifiedName: '"./types.ts"',
			signature: 'import type { Input } from "./types.ts";',
			astKind: "import_statement",
			isImport: true,
			isExported: false,
			members: [],
		});
		result.files[0]?.items.push({
			...structuralEntry,
			rowKind: "sideEffect",
			name: "call register(...) ",
			qualifiedName: "call register(...) ",
			signature: "register(parse);",
			astKind: "expression_statement",
			isImport: false,
			isExported: false,
			members: [],
		});
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-structure",
			{ path: "src/parser.ts" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain('imports\n1-3: import type { Input } from "./types.ts";');
		expect(text).toContain("declarations\n1-3(1): function parse(): void");
		expect(text).toContain("side effects\n1-3: register(parse);");
	});

	it("routes Markdown and renders heading section locators", async () => {
		await workspace.write("README.md", "# Guide\n\n## Installation\n\nInstall it.\n");
		const path = workspace.path("README.md");
		const result = outlineResult(path);
		const file = result.files[0];
		const heading = file?.items[0];
		if (!file || !heading) throw new Error("outline fixture omitted its heading");
		file.language = "markdown";
		heading.name = "Installation";
		heading.qualifiedName = "Guide.Installation";
		heading.symbolType = "heading";
		heading.signature = "## Installation";
		heading.astKind = "atx_heading";
		heading.range = {
			startByte: 9,
			endByte: 39,
			start: { line: 2, column: 0 },
			end: { line: 5, column: 0 },
		};
		heading.nameRange = {
			startByte: 12,
			endByte: 24,
			start: { line: 2, column: 3 },
			end: { line: 2, column: 15 },
		};
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async (target) => {
				expect(target).toEqual({ kind: "file", path, language: "markdown" });
				return result;
			}),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-markdown",
			{ path: "README.md" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		expect(firstText(outlined)).toContain("declarations\n3-5(1): ## Installation");
	});

	it("renders nested TypeScript namespace declarations at qualified depth", async () => {
		const path = workspace.path("src/parser.ts");
		const result = outlineResult(path);
		const namespace = result.files[0]?.items[0];
		if (!namespace) throw new Error("outline fixture omitted its declaration");
		namespace.name = "API";
		namespace.qualifiedName = "API";
		namespace.symbolType = "namespace";
		namespace.signature = "export namespace API {\n  export class Service { … }\n}";
		namespace.bodyRange = { ...range, startByte: 21 };
		namespace.members = [
			{
				...namespace,
				role: "member",
				name: "Service",
				qualifiedName: "API.Service",
				symbolType: "class",
				signature: "export class Service { … }",
				bodyRange: undefined,
				locator: "service-locator",
				isPublic: true,
			},
			{
				...namespace,
				role: "member",
				name: "run",
				qualifiedName: "API.Service.run",
				symbolType: "method",
				signature: "run(): void",
				locator: "run-locator",
				isPublic: true,
			},
		];
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-namespace",
			{ path: "src/parser.ts" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain("1-3(1): export namespace API {");
		expect(text).toContain("  1-3(2): export class Service {");
		expect(text).toContain("    1-3(3): run(): void\n  }\n}");
		expect(text.match(/run\(\): void/g)).toHaveLength(1);
	});

	it("renders source-order Go packages, imports, contracts, and members", async () => {
		await workspace.write("src/parser.go", "package fixture\n");
		const path = workspace.path("src/parser.go");
		const result = outlineResult(path);
		const file = result.files[0];
		if (!file) throw new Error("outline fixture omitted its file");
		file.language = "go";
		const declaration = file.items[0];
		if (!declaration) throw new Error("outline fixture omitted its declaration");
		declaration.name = "Parser";
		declaration.qualifiedName = "Parser";
		declaration.symbolType = "interface";
		declaration.signature = "type Parser interface {\n  Parse(source string) Result\n}";
		declaration.astKind = "type_spec";
		declaration.members = [
			{
				...declaration,
				role: "member",
				name: "Parse",
				qualifiedName: "Parser.Parse",
				symbolType: "method",
				signature: "Parse(source string) Result",
				astKind: "method_elem",
				locator: "go-member-locator",
				isPublic: true,
			},
		];
		const { locator: _locator, ...structural } = declaration;
		file.items.unshift(
			{
				...structural,
				rowKind: "package",
				name: "fixture",
				qualifiedName: "fixture",
				signature: "package fixture",
				astKind: "package_clause",
				isImport: false,
				isExported: false,
				members: [],
			},
			{
				...structural,
				rowKind: "import",
				name: "import",
				qualifiedName: "import",
				signature: 'import "strings"',
				astKind: "import_declaration",
				isImport: true,
				isExported: false,
				members: [],
			},
		);
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-go",
			{ path: "src/parser.go" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain("package\n1-3: package fixture");
		expect(text).toContain('imports\n1-3: import "strings"');
		expect(text).toContain("declarations\n1-3(1): type Parser interface {");
		expect(text).toContain("  1-3(2): Parse(source string) Result\n}");
		expect(text.match(/Parse\(source string\) Result/g)).toHaveLength(1);
	});

	it("renders Odin structure and exact signatures through the selective adapter path", async () => {
		await workspace.write("src/parser.odin", "package fixture\n");
		const path = workspace.path("src/parser.odin");
		const result = outlineResult(path);
		const file = result.files[0];
		if (!file) throw new Error("outline fixture omitted its file");
		file.language = "odin";
		const declaration = file.items[0];
		if (!declaration) throw new Error("outline fixture omitted its declaration");
		declaration.name = "Parser";
		declaration.qualifiedName = "Parser";
		declaration.symbolType = "struct";
		declaration.signature = "@(align=16)\nParser :: struct {\n  parse: proc(string) -> bool,\n}";
		declaration.bodyRange = range;
		declaration.members = [
			{
				...declaration,
				role: "member",
				name: "parse",
				qualifiedName: "Parser.parse",
				symbolType: "field",
				signature: "parse: proc(string) -> bool,",
				astKind: "field",
				locator: "odin-member",
				isPublic: true,
			},
		];
		const { locator: _locator, ...structural } = declaration;
		file.items.unshift(
			{
				...structural,
				rowKind: "package",
				name: "fixture",
				qualifiedName: "fixture",
				signature: "package fixture",
				astKind: "package_declaration",
				isImport: false,
				isExported: false,
				members: [],
			},
			{
				...structural,
				rowKind: "import",
				name: "import",
				qualifiedName: "import",
				signature: 'import fmt "core:fmt"',
				astKind: "import_declaration",
				isImport: true,
				isExported: false,
				members: [],
			},
		);
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-odin",
			{ path: "src/parser.odin" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain("package\n1-3: package fixture");
		expect(text).toContain('imports\n1-3: import fmt "core:fmt"');
		expect(text).toContain("@(align=16)\n1-3(1): Parser :: struct {");
		expect(text).toContain("  1-3(2): parse: proc(string) -> bool,\n}");
		expect(text.match(/parse: proc\(string\) -> bool/g)).toHaveLength(1);
	});

	it("renders source-order Rust uses, impls, and tuple fields", async () => {
		await workspace.write("src/parser.rs", "pub struct Pair(pub u8, String);\n");
		const path = workspace.path("src/parser.rs");
		const result = outlineResult(path);
		const file = result.files[0];
		if (!file) throw new Error("outline fixture omitted its file");
		file.language = "rust";
		const declaration = file.items[0];
		if (!declaration) throw new Error("outline fixture omitted its declaration");
		declaration.name = "Pair";
		declaration.qualifiedName = "Pair";
		declaration.symbolType = "struct";
		declaration.signature = "pub struct Pair<T>(\n  0: pub u8,\n  1: String,\n) where T: Clone;";
		declaration.astKind = "struct_item";
		declaration.members = [
			{
				...declaration,
				role: "member",
				name: "0",
				qualifiedName: "Pair.0",
				symbolType: "field",
				signature: "0: pub u8",
				astKind: "primitive_type",
				locator: "rust-field-0",
				isPublic: true,
			},
			{
				...declaration,
				role: "member",
				name: "1",
				qualifiedName: "Pair.1",
				symbolType: "field",
				signature: "1: String",
				astKind: "type_identifier",
				locator: "rust-field-1",
				isPublic: false,
			},
		];
		const { locator: _locator, ...structural } = declaration;
		file.items.unshift({
			...structural,
			rowKind: "import",
			name: "use",
			qualifiedName: "use",
			signature: "use std::fmt::Debug;",
			astKind: "use_declaration",
			isImport: true,
			isExported: false,
			members: [],
		});
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-rust",
			{ path: "src/parser.rs", includePrivate: true },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain("imports\n1-3: use std::fmt::Debug;");
		expect(text).toContain("declarations\n1-3(1): pub struct Pair<T>(");
		expect(text).toContain("  1-3(2): 0: pub u8");
		expect(text).toContain("  1-3(3): 1: String\n) where T: Clone;");
		expect(text.match(/0: pub u8/g)).toHaveLength(1);
	});

	it("renders source-order Java packages, imports, contracts, and nested members", async () => {
		await workspace.write("src/Parser.java", "package fixture;\n");
		const path = workspace.path("src/Parser.java");
		const result = outlineResult(path);
		const file = result.files[0];
		if (!file) throw new Error("outline fixture omitted its file");
		file.language = "java";
		const declaration = file.items[0];
		if (!declaration) throw new Error("outline fixture omitted its declaration");
		declaration.name = "Parser";
		declaration.qualifiedName = "Parser";
		declaration.symbolType = "interface";
		declaration.nameRange = {
			...declaration.nameRange,
			start: { line: 2, column: 17 },
			end: { line: 2, column: 23 },
		};
		declaration.signature =
			"/**\n * Parser docs.\n */\n@JsonTypeName(\n  defaultImpl = Parser.class\n)\npublic interface Parser {\n  Result parse(String source);\n}";
		declaration.astKind = "interface_declaration";
		declaration.members = [
			{
				...declaration,
				role: "member",
				name: "parse",
				qualifiedName: "Parser.parse",
				symbolType: "method",
				signature: "Result parse(String source);",
				astKind: "method_declaration",
				locator: "java-member-locator",
				isPublic: true,
			},
		];
		const { locator: _locator, ...structural } = declaration;
		file.items.unshift(
			{
				...structural,
				rowKind: "package",
				name: "fixture",
				qualifiedName: "fixture",
				signature: "package fixture;",
				astKind: "package_declaration",
				isImport: false,
				isExported: false,
				members: [],
			},
			{
				...structural,
				rowKind: "import",
				name: "import",
				qualifiedName: "import",
				signature: "import java.io.IOException;",
				astKind: "import_declaration",
				isImport: true,
				isExported: false,
				members: [],
			},
		);
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-java",
			{ path: "src/Parser.java" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain("package\n1-3: package fixture;");
		expect(text).toContain("imports\n1-3: import java.io.IOException;");
		expect(text).toContain("public interface Parser {");
		expect(text).toContain("1-3(1): public interface Parser {");
		expect(text).not.toContain("(1):  * Parser docs.");
		expect(text).not.toContain("(1):   defaultImpl = Parser.class");
		expect(text).toContain("  1-3(2): Result parse(String source);\n}");
		expect(text.match(/Result parse\(String source\);/g)).toHaveLength(1);
	});

	it("renders C# namespaces, contracts, and accessors through the selective adapter path", async () => {
		await workspace.write("src/Parser.cs", "namespace Fixture;\n");
		const path = workspace.path("src/Parser.cs");
		const result = outlineResult(path);
		const file = result.files[0];
		if (!file) throw new Error("outline fixture omitted its file");
		file.language = "cSharp";
		const declaration = file.items[0];
		if (!declaration) throw new Error("outline fixture omitted its declaration");
		declaration.name = "Parser";
		declaration.qualifiedName = "Fixture.Parser";
		declaration.symbolType = "class";
		declaration.signature = "public class Parser {\n  public string Name { … }\n}";
		declaration.bodyRange = range;
		declaration.members = [
			{
				...declaration,
				role: "member",
				name: "Name",
				qualifiedName: "Fixture.Parser.Name",
				symbolType: "property",
				signature: "public string Name { … }",
				locator: "csharp-property",
				isPublic: true,
			},
			{
				...declaration,
				role: "member",
				name: "get",
				qualifiedName: "Fixture.Parser.Name.get",
				symbolType: "property",
				signature: "get;",
				locator: "csharp-get",
				isPublic: true,
			},
		];
		const { locator: _locator, ...structural } = declaration;
		file.items.unshift({
			...structural,
			rowKind: "package",
			name: "Fixture",
			qualifiedName: "Fixture",
			signature: "namespace Fixture;",
			astKind: "file_scoped_namespace_declaration",
			isImport: false,
			isExported: false,
			members: [],
		});
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-csharp",
			{ path: "src/Parser.cs" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain("package\n1-3: namespace Fixture;");
		expect(text).toContain("declarations\n1-3(1): public class Parser {");
		expect(text).toContain("  1-3(2): public string Name {");
		expect(text).toContain("    1-3(3): get;\n  }\n}");
		expect(text.match(/public string Name/g)).toHaveLength(1);
	});

	it("renders Kotlin contracts and nested members through the selective adapter path", async () => {
		await workspace.write("src/Parser.kt", "package fixture\n");
		const path = workspace.path("src/Parser.kt");
		const result = outlineResult(path);
		const file = result.files[0];
		if (!file) throw new Error("outline fixture omitted its file");
		file.language = "kotlin";
		const declaration = file.items[0];
		if (!declaration) throw new Error("outline fixture omitted its declaration");
		declaration.name = "Parser";
		declaration.qualifiedName = "Parser";
		declaration.symbolType = "interface";
		declaration.signature = "interface Parser {\n  fun parse(source: String): Result\n}";
		declaration.members = [
			{
				...declaration,
				role: "member",
				name: "parse",
				qualifiedName: "Parser.parse",
				symbolType: "method",
				signature: "fun parse(source: String): Result",
				locator: "kotlin-member",
				isPublic: true,
			},
		];
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-kotlin",
			{ path: "src/Parser.kt" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain("declarations\n1-3(1): interface Parser {");
		expect(text).toContain("  1-3(2): fun parse(source: String): Result\n}");
		expect(text.match(/fun parse\(source: String\): Result/g)).toHaveLength(1);
	});

	it("renders Swift extensions and members through the selective adapter path", async () => {
		await workspace.write("src/Parser.swift", "public extension Parser {}\n");
		const path = workspace.path("src/Parser.swift");
		const result = outlineResult(path);
		const file = result.files[0];
		if (!file) throw new Error("outline fixture omitted its file");
		file.language = "swift";
		const declaration = file.items[0];
		if (!declaration) throw new Error("outline fixture omitted its declaration");
		declaration.name = "Parser";
		declaration.qualifiedName = "extension Parser: Sendable";
		declaration.symbolType = "namespace";
		declaration.signature = "public extension Parser: Sendable {\n  func parse() async\n}";
		declaration.members = [
			{
				...declaration,
				role: "member",
				name: "parse",
				qualifiedName: "extension Parser: Sendable.parse",
				symbolType: "method",
				signature: "func parse() async",
				locator: "swift-member",
				isPublic: true,
			},
		];
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-swift",
			{ path: "src/Parser.swift" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain("declarations\n1-3(1): public extension Parser: Sendable {");
		expect(text).toContain("  1-3(2): func parse() async\n}");
		expect(text.match(/func parse\(\) async/g)).toHaveLength(1);
	});

	it("keeps attached documentation before the locator and renders container members once", async () => {
		const path = workspace.path("src/parser.ts");
		const result = outlineResult(path);
		const declaration = result.files[0]?.items[0];
		if (!declaration) throw new Error("outline fixture omitted its declaration");
		declaration.range = {
			startByte: 0,
			endByte: 70,
			start: { line: 0, column: 0 },
			end: { line: 4, column: 0 },
		};
		declaration.nameRange = {
			startByte: 55,
			endByte: 60,
			start: { line: 3, column: 16 },
			end: { line: 3, column: 21 },
		};
		declaration.signature = "/**\n * Parse input.\n */\nexport function parse(): void";
		result.files[0]?.items.push({
			rowKind: "declaration",
			role: "item",
			symbolType: "class",
			name: "Worker",
			qualifiedName: "Worker",
			range: {
				startByte: 71,
				endByte: 120,
				start: { line: 5, column: 0 },
				end: { line: 8, column: 1 },
			},
			nameRange: {
				startByte: 84,
				endByte: 90,
				start: { line: 5, column: 13 },
				end: { line: 5, column: 19 },
			},
			signature: "export class Worker {\n  reset(): void\n}",
			astKind: "class_declaration",
			certainty: "certain",
			locator: "worker-locator",
			isImport: false,
			isExported: true,
			members: [
				{
					role: "member",
					symbolType: "method",
					name: "reset",
					qualifiedName: "Worker.reset",
					range: {
						startByte: 95,
						endByte: 108,
						start: { line: 6, column: 1 },
						end: { line: 6, column: 14 },
					},
					nameRange: {
						startByte: 96,
						endByte: 101,
						start: { line: 6, column: 2 },
						end: { line: 6, column: 7 },
					},
					signature: "reset(): void",
					astKind: "method_definition",
					certainty: "certain",
					locator: "reset-locator",
					isPublic: true,
				},
			],
		});
		const interfaceSignature = "export interface Contract {\n\trun(): void;\n}";
		const interfaceStart = 121;
		result.files[0]?.items.push({
			rowKind: "declaration",
			role: "item",
			symbolType: "interface",
			name: "Contract",
			qualifiedName: "Contract",
			range: {
				startByte: interfaceStart,
				endByte: interfaceStart + Buffer.byteLength(interfaceSignature),
				start: { line: 9, column: 0 },
				end: { line: 11, column: 1 },
			},
			nameRange: {
				startByte: interfaceStart + 17,
				endByte: interfaceStart + 25,
				start: { line: 9, column: 17 },
				end: { line: 9, column: 25 },
			},
			signature: interfaceSignature,
			astKind: "interface_declaration",
			certainty: "certain",
			locator: "contract-locator",
			isImport: false,
			isExported: true,
			members: [
				{
					role: "member",
					symbolType: "method",
					name: "run",
					qualifiedName: "Contract.run",
					range: {
						startByte: interfaceStart + Buffer.byteLength("export interface Contract {\n\t"),
						endByte: interfaceStart + Buffer.byteLength("export interface Contract {\n\trun(): void;"),
						start: { line: 10, column: 1 },
						end: { line: 10, column: 13 },
					},
					nameRange: {
						startByte: interfaceStart + Buffer.byteLength("export interface Contract {\n\t"),
						endByte: interfaceStart + Buffer.byteLength("export interface Contract {\n\trun"),
						start: { line: 10, column: 1 },
						end: { line: 10, column: 4 },
					},
					signature: "run(): void;",
					astKind: "method_signature",
					certainty: "certain",
					locator: "run-locator",
					isPublic: true,
				},
			],
		});
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-contracts",
			{ path: "src/parser.ts" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const text = firstText(outlined);
		expect(text).toContain("/**\n * Parse input.\n */\n1-4(1): export function parse(): void");
		expect(text).not.toContain("parse /**");
		expect(text).toContain("6-9(2): export class Worker {\n  7(3): reset(): void\n}");
		expect(text.match(/reset\(\): void/g)).toHaveLength(1);
		expect(text).toContain("10-12(4): export interface Contract {\n  11(5): run(): void;\n}");
		expect(text.match(/run\(\): void;/g)).toHaveLength(1);
	});

	it("keeps distinct numeric IDs for public aliases sharing one native locator", async () => {
		const path = workspace.path("src/parser.ts");
		const result = outlineResult(path);
		const first = result.files[0]?.items[0];
		if (!first) throw new Error("outline fixture omitted its declaration");
		first.name = "createThing";
		result.files[0]?.items.push({ ...first, name: "makeThing" });
		const symbolResult: SymbolBatchResult = {
			declarations: [
				{
					locator: "native-locator",
					path,
					language: "typeScript",
					sourceFingerprint: "blake3:test",
					declarationRange: range,
				},
			],
			blocks: [{ path, returnedRange: range, declarationIndexes: [0], source: "function buildThing() {}" }],
		};
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => result),
			symbol: vi.fn(async () => symbolResult),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const outlined = await ast.outline.execute(
			"outline-aliases",
			{ path: "src/parser.ts" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		expect(firstText(outlined)).toContain("1-3(1): createThing function parse(): void");
		expect(firstText(outlined)).toContain("1-3(2): makeThing function parse(): void");

		const symbol = await ast.symbol.execute(
			"symbol-aliases",
			{ locators: [1, 2], view: "declaration" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		expect(client.symbol).toHaveBeenCalledWith(["native-locator"], "declaration", 0, undefined);
		expect(firstText(symbol)).toContain("1-3(1,2): createThing, makeThing");
	});

	it("renders one Errata-style call row and a separate parenthesized result summary", async () => {
		const path = workspace.path("src/parser.ts");
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => outlineResult(path)),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const args = {
			path: "src/a/very/long/package/parser.ts",
			includePrivate: true,
			names: ["Parser", "parse", "reset"],
		};
		const call = ast.outline.renderCall?.(args, testTheme, renderContext(args, false));
		const callLine = call?.render(200).join("\n") ?? "";
		expect(callLine).toContain("outline");
		expect(callLine).toContain("→");
		expect(callLine).toContain("parser.ts");
		expect(callLine).toContain("[private names=");

		const result = await ast.outline.execute(
			"outline-1",
			{ path: "src/parser.ts" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		const collapsed = renderedText(
			ast.outline.renderResult?.(
				result,
				{ expanded: false, isPartial: false },
				testTheme,
				renderContext(args, false),
			),
		);
		expect(collapsed).toContain("1 declaration, ");
		expect(collapsed).toMatch(/\(.*to expand.*\)/s);
		expect(collapsed).not.toContain("outline");

		const expanded = renderedText(
			ast.outline.renderResult?.(result, { expanded: true, isPartial: false }, testTheme, renderContext(args, true)),
		);
		expect(expanded).toContain("declarations");
		expect(expanded).not.toContain("to expand");
	});

	it("rejects unsupported files and invalidates every locator path after mutation", async () => {
		await workspace.write("README.txt", "docs\n");
		const path = resolve(workspace.dir, "src/parser.ts");
		const client: AstClient = {
			getGeneration: () => 1,
			outline: vi.fn(async () => outlineResult(path)),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		await expect(
			ast.outline.execute(
				"outline-1",
				{ path: "README.txt" },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			),
		).rejects.toThrow("Unsupported outline file type");

		await ast.outline.execute(
			"outline-2",
			{ path: "src/parser.ts" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		await expect(
			ast.symbol.execute(
				"symbol-unknown",
				{ locators: [1, 999], view: "declaration" },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			),
		).rejects.toThrow("Unknown symbol locator: 999");
		expect(client.symbol).not.toHaveBeenCalled();
		ast.invalidate([path]);
		await expect(
			ast.symbol.execute(
				"symbol-1",
				{ locators: [1], view: "declaration" },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			),
		).rejects.toThrow("is stale");
		expect(client.symbol).not.toHaveBeenCalled();
	});
});
