import { describe, expect, test } from "vitest";
import { queryContext } from "../../../src/ast/queries/context.ts";
import { withExplore } from "./helpers.ts";

const CONTROLLER = `export class SplashController {
	first(): number {
		return 1;
	}

	second(): number {
		return 2;
	}
}
`;

describe("context packing", () => {
	test("a type target prints its signature once and its members separately", async () => {
		await withExplore({ "controller.ts": CONTROLLER }, async ({ engine, graph, workspace, signal }) => {
			const result = await queryContext({
				engine,
				graph,
				scopePath: workspace.dir,
				targetPath: "controller.ts",
				name: "SplashController",
				line: undefined,
				budget: 2000,
				signal,
			});
			if (result.kind !== "resolved") throw new Error(`expected resolved, got ${result.kind}`);

			const target = result.groups.find((group) => group.id === "target");
			expect(target?.entries[0]?.view).toBe("signature");
			expect(target?.entries[0]?.text).not.toContain("return 1;");
			expect(target?.entries[0]?.flags).toEqual([]);

			const methods = result.groups.find((group) => group.id === "methods");
			expect(methods?.entries.map((entry) => entry.name)).toEqual(["first", "second"]);
		});
	});
});
