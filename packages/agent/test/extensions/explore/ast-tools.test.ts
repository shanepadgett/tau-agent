import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAstTools } from "../../../extensions/explore/ast-tools.ts";
import type { AstClient, OutlineResult, SymbolResult } from "../../../extensions/explore/ast-worker.ts";
import { extensionContext, firstText, testRowState } from "./helpers.ts";

const range = {
	startByte: 0,
	endByte: 28,
	start: { line: 0, column: 0 },
	end: { line: 2, column: 1 },
};

function outlineResult(path: string): OutlineResult {
	return {
		path,
		language: "typeScript",
		sourceFingerprint: "blake3:test",
		byteLength: 200,
		lineCount: 10,
		diagnostics: { errorNodes: 0, missingNodes: 0 },
		items: [
			{
				role: "item",
				symbolType: "function",
				name: "parse",
				range,
				signature: "function parse(): void",
				astKind: "function_declaration",
				locator: "native-locator",
				isImport: false,
				isExported: true,
				members: [],
			},
		],
	};
}

describe("AST exploration tools", () => {
	it("outlines supported files and resolves short locators to exact symbols", async () => {
		const cwd = "/work/project";
		const source = "function parse(): void {}";
		const symbolResult: SymbolResult = {
			path: resolve(cwd, "src/parser.ts"),
			language: "typeScript",
			sourceFingerprint: "blake3:test",
			range,
			source,
		};
		const client: AstClient = {
			outline: vi.fn(async (path, language) => {
				expect(path).toBe(resolve(cwd, "src/parser.ts"));
				expect(language).toBe("typeScript");
				return outlineResult(path);
			}),
			symbol: vi.fn(async (locator) => {
				expect(locator).toBe("native-locator");
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
			extensionContext(cwd),
		);
		expect(firstText(outlined)).toContain("ast:1 L1-3 function function parse(): void");
		expect(outlined.details?.avoidedBytes).toBeGreaterThan(0);

		const symbol = await ast.symbol.execute(
			"symbol-1",
			{ locator: "ast:1" },
			undefined,
			undefined,
			extensionContext(cwd),
		);
		expect(firstText(symbol)).toContain(source);
		expect(client.symbol).toHaveBeenCalledOnce();
	});

	it("maps every supported source extension to its worker language", async () => {
		const cwd = "/work/project";
		const client: AstClient = {
			outline: vi.fn(async (path, language) => ({ ...outlineResult(path), language })),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		const cases = [
			["file.ts", "typeScript"],
			["file.tsx", "tsx"],
			["file.odin", "odin"],
			["file.go", "go"],
			["file.rs", "rust"],
			["file.cs", "cSharp"],
			["file.java", "java"],
			["file.kt", "kotlin"],
			["file.ktm", "kotlin"],
			["file.kts", "kotlin"],
			["file.swift", "swift"],
		] as const;

		for (const [index, [file, language]] of cases.entries()) {
			await ast.outline.execute(`outline-${index}`, { path: file }, undefined, undefined, extensionContext(cwd));
			expect(client.outline).toHaveBeenNthCalledWith(index + 1, resolve(cwd, file), language, undefined);
		}
	});

	it("keeps a declaration name visible when its signature contains only annotations", async () => {
		const cwd = "/work/project";
		const path = resolve(cwd, "Parser.java");
		const result = outlineResult(path);
		result.items[0].signature = "@Generated";
		const client: AstClient = {
			outline: vi.fn(async () => result),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);

		const outlined = await ast.outline.execute(
			"outline-1",
			{ path: "Parser.java" },
			undefined,
			undefined,
			extensionContext(cwd),
		);

		expect(firstText(outlined)).toContain("function parse @Generated");
	});

	it("rejects unsupported files and invalidates locators after mutation", async () => {
		const cwd = "/work/project";
		const path = resolve(cwd, "src/parser.ts");
		const client: AstClient = {
			outline: vi.fn(async () => outlineResult(path)),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		await expect(
			ast.outline.execute("outline-1", { path: "README.md" }, undefined, undefined, extensionContext(cwd)),
		).rejects.toThrow("Unsupported outline file type");

		await ast.outline.execute("outline-2", { path: "src/parser.ts" }, undefined, undefined, extensionContext(cwd));
		ast.invalidate([path]);
		await expect(
			ast.symbol.execute("symbol-1", { locator: "ast:1" }, undefined, undefined, extensionContext(cwd)),
		).rejects.toThrow("is stale");
		expect(client.symbol).not.toHaveBeenCalled();
	});
});
