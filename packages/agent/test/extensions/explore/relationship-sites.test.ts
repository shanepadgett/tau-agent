import { describe, expect, test } from "vitest";
import {
	queryRelationships,
	type RelationshipOp,
	type RelationshipSite,
} from "../../../src/ast/graph/relationships.ts";
import { withExplore, type ExploreFixture } from "./helpers.ts";

async function sites(
	fixture: ExploreFixture,
	op: RelationshipOp,
	name: string,
	targetPath: string,
): Promise<RelationshipSite[]> {
	const result = await queryRelationships({
		engine: fixture.engine,
		graph: fixture.graph,
		scopePath: fixture.workspace.dir,
		op,
		targetPath,
		name,
		line: undefined,
		resultLimit: 20,
		signal: fixture.signal,
	});
	if (result.kind !== "resolved") throw new Error(`expected resolved, got ${result.kind}`);
	return result.sites;
}

describe("relationship sites", () => {
	test("declaration-shaped sites preview the declaration, not the annotation above it", async () => {
		await withExplore(
			{
				"p/Api.java": "package p;\n\npublic interface Api {\n\tvoid run();\n}\n",
				"p/Internal.java": "package p;\n\npublic @interface Internal {}\n",
				"p/Impl.java":
					"package p;\n\nimport p.Api;\n\n@Internal\npublic class Impl implements Api {\n\tpublic void run() {}\n}\n",
			},
			async (fixture) => {
				const found = await sites(fixture, "implementations", "Api", "p/Api.java");
				expect(found).toHaveLength(1);
				expect(found[0]?.preview).toContain("class Impl implements Api");
				// Annotation-led types used to preview as a bare `@Internal` row.
				expect(found[0]?.preview).not.toBe("@Internal");
				// Same package, so no confidence gap to imply.
				expect(found[0]?.certainty).toBe("exact");
			},
		);
	});

	test("a call from a top-level statement is a caller", async () => {
		await withExplore(
			{
				"mod.ts": "export function build(): number {\n\treturn 1;\n}\n",
				"use.ts": 'import { build } from "./mod.ts";\n\nexport const made = build();\n',
			},
			async (fixture) => {
				const found = await sites(fixture, "callers", "build", "mod.ts");
				expect(found.map((site) => `${site.line} ${site.kind}`)).toEqual(["3 call"]);
			},
		);
	});

	test("go interface implementers are found by method set", async () => {
		await withExplore(
			{
				"storage/interface.go":
					"package storage\n\ntype Appender interface {\n\tCommit() error\n}\n\ntype Extended interface {\n\tAppender\n\tRollback() error\n}\n",
				"head/appender.go":
					"package head\n\ntype headAppender struct{}\n\nfunc (a *headAppender) Commit() error { return nil }\n",
				"head/partial.go":
					"package head\n\ntype partialAppender struct{}\n\nfunc (a *partialAppender) Flush() error { return nil }\n",
			},
			async (fixture) => {
				const found = await sites(fixture, "implementations", "Appender", "storage/interface.go");
				const names = found.map((site) => site.path.split("/").at(-1));
				expect(names).toContain("appender.go");
				expect(names).not.toContain("partial.go");
				expect(found.every((site) => site.certainty === "inferred" || site.certainty === "exact")).toBe(true);

				// Embedded interfaces expand: Extended needs Commit + Rollback.
				const extended = await sites(fixture, "implementations", "Extended", "storage/interface.go");
				expect(extended.map((site) => site.path.split("/").at(-1))).not.toContain("appender.go");
			},
		);
	});
});
