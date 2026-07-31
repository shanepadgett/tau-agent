import { beforeAll, describe, expect, test } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import { grammarWasmPath, loadGrammarManifest, runtimeWasmPath } from "../../../src/ast/grammars/manifest.ts";

type Fixture = { source: string; rootType: string };

const fixtures: Record<string, Fixture> = {
	typescript: {
		source: 'export function greet(name: string): string {\n\treturn "hi " + name;\n}\n',
		rootType: "program",
	},
	tsx: {
		source: 'export function App() {\n\treturn <div className="x">hello</div>;\n}\n',
		rootType: "program",
	},
	go: {
		source: "package main\n\nfunc add(a int, b int) int {\n\treturn a + b\n}\n",
		rootType: "source_file",
	},
	rust: {
		source: "pub fn add(a: i32, b: i32) -> i32 {\n\ta + b\n}\n",
		rootType: "source_file",
	},
	c_sharp: {
		source: 'public class Greeter\n{\n\tpublic string Greet(string name) => $"hi {name}";\n}\n',
		rootType: "compilation_unit",
	},
	java: {
		source: 'class Greeter {\n\tString greet(String name) {\n\t\treturn "hi " + name;\n\t}\n}\n',
		rootType: "program",
	},
	kotlin: {
		// String template exercises the external scanner compiled into the wasm.
		source: 'fun greet(name: String): String {\n\treturn "hi $name"\n}\n',
		rootType: "source_file",
	},
	swift: {
		// Interpolation exercises the external scanner compiled into the wasm.
		source: 'func greet(name: String) -> String {\n\treturn "hi \\(name)"\n}\n',
		rootType: "source_file",
	},
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
		test(`${grammar.id} loads and parses`, async () => {
			const fixture = fixtures[grammar.id];
			if (!fixture) throw new Error(`no fixture for ${grammar.id}`);
			const language = await Language.load(grammarWasmPath(grammar));
			const parser = new Parser();
			parser.setLanguage(language);
			const tree = parser.parse(fixture.source);
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
