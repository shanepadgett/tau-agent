import { describe, expect, test } from "vitest";
import { formatAstSearchFile } from "../../../src/ast/format/ast-search.ts";
import type { AstSearchMatch } from "../../../src/ast/queries/ast-search.ts";

function match(overrides: Partial<AstSearchMatch> = {}): AstSearchMatch {
	return {
		path: "/repo/app.kt",
		startLine: 1,
		endLine: 200,
		text: Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"),
		bindings: [],
		enclosing: undefined,
		parseDegraded: false,
		...overrides,
	};
}

describe("ast_search match rows", () => {
	test("a long match prints a bounded head plus an elided count", () => {
		const lines = formatAstSearchFile("/repo/app.kt", [match()], "/repo").split("\n");
		// path header + 12 match lines + elision row
		expect(lines.length).toBe(14);
		expect(lines[1]).toBe("L1-200 line 1");
		expect(lines.at(-1)).toBe("  ... +188 lines");
	});

	test("a multi-line binding prints its size, never its text", () => {
		const body = "if (x) {\n\tdoWork()\n}";
		const lines = formatAstSearchFile(
			"/repo/app.kt",
			[match({ endLine: 3, text: "fun f() {}", bindings: [{ name: "BODY", text: body }] })],
			"/repo",
		);
		expect(lines).toContain("  $BODY = <3 lines>");
		expect(lines).not.toContain("doWork()");
	});
});
