import { describe, expect, test } from "vitest";
import { discover } from "../../../src/ast/queries/discover.ts";
import { withExplore } from "./helpers.ts";

const SOURCE = `/** Priority QUEUE of pending work. */
export class Queue {
	size = 0;
}

export function enqueue(item: string): void {
	void item;
}

export function outlinePath(): void {}

export type OutlineRow = { depth: number };
`;

async function names(
	query: Parameters<typeof discover>[2],
	surface: Parameters<typeof discover>[3] = "all",
): Promise<string[]> {
	let found: string[] = [];
	await withExplore({ "surface.ts": SOURCE }, async ({ engine, signal }) => {
		const result = await discover(engine, ".", query, surface, 20, signal);
		found = result.candidates.map((candidate) => candidate.name);
	});
	return found;
}

describe("discover name matching", () => {
	test("substringName matches both casings", async () => {
		expect((await names({ kind: "substringName", name: "queue" })).sort()).toEqual(["Queue", "enqueue"]);
		expect((await names({ kind: "substringName", name: "QUEUE" })).sort()).toEqual(["Queue", "enqueue"]);
	});

	test("prefixName matches both casings", async () => {
		expect((await names({ kind: "prefixName", name: "outline" })).sort()).toEqual(["OutlineRow", "outlinePath"]);
		expect((await names({ kind: "prefixName", name: "Outline" })).sort()).toEqual(["OutlineRow", "outlinePath"]);
	});

	test("exactName stays case sensitive", async () => {
		expect(await names({ kind: "exactName", name: "Queue" })).toEqual(["Queue"]);
		expect(await names({ kind: "exactName", name: "queue" })).toEqual([]);
	});

	test("fuzzyName folds case and ranks the same-case hit first", async () => {
		const found = await names({ kind: "fuzzyName", name: "Queue", maxCandidates: 10, maxWork: 500 });
		expect(found).toContain("enqueue");
		expect(found[0]).toBe("Queue");
	});

	test("documentation terms fold case", async () => {
		expect(await names({ kind: "documentation", terms: ["queue"], maxCandidates: 10, maxWork: 500 })).toEqual([
			"Queue",
		]);
	});
});
