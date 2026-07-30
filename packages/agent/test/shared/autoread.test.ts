import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAutoreadMessage } from "../../shared/autoread.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("autoread", () => {
	it("rejects files that cannot fit as a complete bounded snapshot", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-autoread-test-"));
		roots.push(cwd);
		await writeFile(join(cwd, "large.jsonl"), "entry\n".repeat(60_000));

		await expect(
			prepareAutoreadMessage({
				rowId: "row",
				path: "large.jsonl",
				cwd,
				source: "test",
				batchId: "batch",
				signal: undefined,
				isLifecycleCurrent: () => true,
			}),
		).rejects.toThrow("File exceeds the complete autoread limit; use ranged read instead");
	});
});
