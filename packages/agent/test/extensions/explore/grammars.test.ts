import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import { grammarWasmPath, loadGrammarManifest, runtimeWasmPath } from "../../../src/ast/grammars/manifest.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ast/languages/fixtures");

/** Grammar id → sample fixture file and expected root node type. */
const fixtures: Record<string, { file: string; rootType: string }> = {
	typescript: { file: "sample.ts", rootType: "program" },
	tsx: { file: "sample.tsx", rootType: "program" },
	go: { file: "sample.go", rootType: "source_file" },
	rust: { file: "sample.rs", rootType: "source_file" },
	c_sharp: { file: "sample.cs", rootType: "compilation_unit" },
	java: { file: "sample.java", rootType: "program" },
	kotlin: { file: "sample.kt", rootType: "source_file" },
	swift: { file: "sample.swift", rootType: "source_file" },
};

const manifest = loadGrammarManifest();

beforeAll(async () => {
	await Parser.init({ locateFile: () => runtimeWasmPath() });
});

describe("grammar artifacts", () => {
	test("manifest languages and fixtures stay in sync", () => {
		expect(manifest.grammars.map((grammar) => grammar.id).sort()).toEqual(Object.keys(fixtures).sort());
	});

	for (const grammar of manifest.grammars) {
		test(`${grammar.id} loads and parses the sample fixture`, async () => {
			const fixture = fixtures[grammar.id];
			if (!fixture) throw new Error(`no fixture for ${grammar.id}`);
			const source = await readFile(join(fixturesDir, fixture.file), "utf8");
			const language = await Language.load(grammarWasmPath(grammar));
			const parser = new Parser();
			parser.setLanguage(language);
			const tree = parser.parse(source);
			try {
				expect(tree).not.toBeNull();
				expect(tree?.rootNode.type).toBe(fixture.rootType);
				expect(tree?.rootNode.hasError).toBe(false);
			} finally {
				tree?.delete();
				parser.delete();
			}
		});
	}
});
