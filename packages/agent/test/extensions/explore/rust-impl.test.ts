import { describe, expect, test } from "vitest";
import { resolveTarget } from "../../../src/ast/identity.ts";
import { outlinePath } from "../../../src/ast/queries/outline.ts";
import { withExplore } from "./helpers.ts";

const LIST = `pub struct LinkedList {
	len: usize,
}

impl LinkedList {
	pub fn new() -> Self {
		LinkedList { len: 0 }
	}
}

impl Default for LinkedList {
	fn default() -> Self {
		LinkedList::new()
	}
}
`;

describe("rust impl blocks", () => {
	test("impl blocks are containers that own their methods and do not shadow the type", async () => {
		await withExplore({ "list.rs": LIST }, async ({ engine, workspace, signal }) => {
			const result = await outlinePath(
				engine,
				"list.rs",
				{ includePrivate: true, includeDocs: false, names: [] },
				signal,
			);
			if (result.mode !== "file") throw new Error("expected a file outline");
			const rows = result.file.rows.map((row) => `${row.depth} ${row.kind} ${row.name}`);
			expect(rows).toEqual([
				"0 struct LinkedList",
				"1 field len",
				"0 class impl LinkedList",
				"1 method new",
				"0 class impl Default for LinkedList",
				"1 method default",
			]);
			// Signature stops at the impl header instead of reprinting the whole body.
			const container = result.file.rows.find((row) => row.name === "impl Default for LinkedList");
			expect(container?.signature).not.toContain("LinkedList::new()");

			// Methods keep their owner, so callers/impact still resolve.
			expect(result.file.rows.find((row) => row.name === "new")?.qualifiedName).toBe("LinkedList.new");

			const resolution = await resolveTarget(engine, workspace.dir, { name: "LinkedList" }, signal);
			expect(resolution.kind).toBe("resolved");
		});
	});
});
