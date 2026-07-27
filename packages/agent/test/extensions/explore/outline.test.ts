import { describe, expect, test } from "vitest";
import { createExploreEngine } from "../../../extensions/explore/ast/engine.ts";
import { outlinePath } from "../../../extensions/explore/ast/queries/outline.ts";
import { createWorkspace } from "../../helpers.ts";

describe("outline", () => {
	test("omits multiline TSX initializers and wrapped callback bodies", async () => {
		const workspace = await createWorkspace();
		const engine = createExploreEngine({ cwd: workspace.dir });
		try {
			await workspace.write(
				"route.tsx",
				`export const STATE: Readonly<Record<string, string>> = {
	draft: "Draft",
	delivery: "Delivery",
};

export const CatalogPage = define.page(async function CatalogPage({ state }) {
	const catalog = await loadCatalog(state);
	return <main>{catalog.name}</main>;
});

export default define.page(async function DefaultPage({ state }) {
	const catalog = await loadCatalog(state);
	return <main>{catalog.name}</main>;
});

export function CatalogLanding({ name }: { name: string }) {
	return <main>{name}</main>;
}
`,
			);

			const result = await outlinePath(
				engine,
				"route.tsx",
				{ includePrivate: false, includeDocs: false, names: [] },
				new AbortController().signal,
			);
			if (result.mode !== "file") throw new Error("expected a file outline");

			expect(result.file.rows.map((row) => row.signature)).toEqual([
				"export const STATE: Readonly<Record<string, string>> = …;",
				"export const CatalogPage = define.page(async function CatalogPage({ state }) { … });",
				"export default define.page(async function DefaultPage({ state }) { … });",
				"export function CatalogLanding({ name }: { name: string }) ",
			]);
		} finally {
			engine.shutdown();
			await workspace.cleanup();
		}
	});
});
