import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createExploreEngine } from "../../../src/ast/engine.ts";
import type { Decl } from "../../../src/ast/ir.ts";
import { createDefaultRegistry } from "../../../src/ast/registry.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ast/languages/fixtures");

type ExpectedDecl = {
	kind: string;
	qualifiedName: string;
	visibility: string;
	exported: boolean;
	children: ExpectedDecl[];
};

type ExpectedShape = {
	languageId: string;
	parseDegraded: boolean;
	imports: string[];
	decls: ExpectedDecl[];
};

function summarize(decls: readonly Decl[]): ExpectedDecl[] {
	return decls.map((decl) => ({
		kind: decl.kind,
		qualifiedName: decl.qualifiedName,
		visibility: decl.visibility,
		exported: decl.exported,
		children: summarize(decl.children),
	}));
}

async function fixtureFiles(): Promise<string[]> {
	const entries = await readdir(fixturesDir);
	return entries.filter((name) => name.startsWith("sample.") && !name.endsWith(".json")).sort();
}

describe("language fixtures", () => {
	test("every registered language has a sample fixture", async () => {
		const registry = createDefaultRegistry();
		const files = await fixtureFiles();
		const engine = createExploreEngine({ cwd: fixturesDir, registry });
		try {
			const covered = new Set<string>();
			for (const file of files) {
				const ir = await engine.irForFile(join(fixturesDir, file));
				covered.add(ir.languageId);
			}
			const registered = registry
				.registeredLanguages()
				.map((language) => language.id)
				.sort();
			expect([...covered].sort()).toEqual(registered);
		} finally {
			engine.shutdown();
		}
	});

	test("sample fixtures stay in sync with expected extract shapes", async () => {
		const files = await fixtureFiles();
		const engine = createExploreEngine({ cwd: fixturesDir });
		try {
			for (const file of files) {
				const path = join(fixturesDir, file);
				const expectedPath = join(fixturesDir, `${file}.expected.json`);
				const ir = await engine.irForFile(path);
				const expected = JSON.parse(await readFile(expectedPath, "utf8")) as ExpectedShape;
				expect(
					{
						languageId: ir.languageId,
						parseDegraded: ir.parseDegraded,
						imports: ir.imports.map((entry) => entry.specifier),
						decls: summarize(ir.decls),
					},
					basename(file),
				).toEqual(expected);
			}
		} finally {
			engine.shutdown();
		}
	});
});
