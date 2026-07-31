import { describe, expect, test } from "vitest";
import { outlinePath } from "../../../src/ast/queries/outline.ts";
import { withExplore } from "./helpers.ts";

const DEFAULT_OPTIONS = { includePrivate: false, includeDocs: false, names: [] as readonly string[] };

async function defaultOutlineNames(files: Record<string, string>, path: string): Promise<string[]> {
	let names: string[] = [];
	await withExplore(files, async ({ engine, signal }) => {
		const result = await outlinePath(engine, path, DEFAULT_OPTIONS, signal);
		if (result.mode !== "file") throw new Error("expected a file outline");
		names = result.file.rows.map((row) => row.qualifiedName);
	});
	return names;
}

describe("outline default visibility", () => {
	test("go lists package-visible types alongside their exported methods", async () => {
		const names = await defaultOutlineNames(
			{
				"series.go": `package agent

type memSeries struct {
	ref uint64
}

func (s *memSeries) Append(v float64) {}

func newMemSeries() *memSeries { return &memSeries{} }
`,
			},
			"series.go",
		);
		expect(names).toContain("memSeries");
		expect(names).toContain("memSeries.Append");
		expect(names).toContain("newMemSeries");
	});

	test("rust keeps pub(crate) and hides private", async () => {
		const names = await defaultOutlineNames(
			{
				"lib.rs": `pub(crate) struct Shared {
	value: u32,
}

struct Hidden {
	value: u32,
}

pub fn exposed() {}
`,
			},
			"lib.rs",
		);
		expect(names).toContain("Shared");
		expect(names).toContain("exposed");
		expect(names).not.toContain("Hidden");
	});

	test("swift keeps internal and hides fileprivate", async () => {
		const names = await defaultOutlineNames(
			{
				"Model.swift": `struct Reading {
	let value: Double
}

fileprivate struct Buffer {
	let size: Int
}
`,
			},
			"Model.swift",
		);
		expect(names).toContain("Reading");
		expect(names).not.toContain("Buffer");
	});
});
