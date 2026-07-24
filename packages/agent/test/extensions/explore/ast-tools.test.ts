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
			outline: vi.fn(async (target, includePrivate, names) => {
				expect(target).toEqual({ kind: "file", path, language: "typeScript" });
				expect(includePrivate).toBe(false);
				expect(names).toEqual([]);
				return outlineResult(path);
			}),
			symbol: vi.fn(async (locators, contextLines) => {
				expect(locators).toEqual(["native-locator"]);
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
		expect(firstText(outlined)).toContain("public function\n1-3(1): function parse(): void");

		const symbolArgs = { locators: [1], contextLines: 2 };
		const symbolCall = ast.symbol.renderCall?.(symbolArgs, testTheme, renderContext(symbolArgs, false));
		const symbolCallLine = symbolCall?.render(200).join("\n") ?? "";
		expect(symbolCallLine).toContain("symbol");
		expect(symbolCallLine).toContain("parser.ts: parse");
		expect(symbolCallLine).toContain("[context=2]");
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
	});

	it("sends directories and public-surface options to the worker", async () => {
		await workspace.mkdir("src/package");
		const path = workspace.path("src/package");
		const client: AstClient = {
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

		expect(client.outline).toHaveBeenCalledWith({ kind: "directory", path }, true, ["Foo", "bar"], undefined);
		expect(firstText(result)).toContain("No matching declarations");
	});

	it("renders one Errata-style call row and a separate parenthesized result summary", async () => {
		const path = workspace.path("src/parser.ts");
		const client: AstClient = {
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
		expect(expanded).toContain("public function");
		expect(expanded).not.toContain("to expand");
	});

	it("rejects unsupported files and invalidates every locator path after mutation", async () => {
		await workspace.write("README.md", "docs\n");
		const path = resolve(workspace.dir, "src/parser.ts");
		const client: AstClient = {
			outline: vi.fn(async () => outlineResult(path)),
			symbol: vi.fn(),
			shutdown: vi.fn(async () => {}),
		};
		const ast = createAstTools(client, testRowState);
		await expect(
			ast.outline.execute("outline-1", { path: "README.md" }, undefined, undefined, extensionContext(workspace.dir)),
		).rejects.toThrow("Unsupported outline file type");

		await ast.outline.execute(
			"outline-2",
			{ path: "src/parser.ts" },
			undefined,
			undefined,
			extensionContext(workspace.dir),
		);
		ast.invalidate([path]);
		await expect(
			ast.symbol.execute("symbol-1", { locators: [1] }, undefined, undefined, extensionContext(workspace.dir)),
		).rejects.toThrow("is stale");
		expect(client.symbol).not.toHaveBeenCalled();
	});
});
