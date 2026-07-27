import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contextProjectionKey, type SelectedContext } from "../../../extensions/context/projection.ts";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("context projection", () => {
	it("invalidates cached projections when content changes under identical metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-context-projection-key-"));
		roots.push(root);
		await mkdir(join(root, "src"));
		const path = join(root, "src", "main.ts");
		await writeFile(path, "export const a = 1;\n");
		const metadata = await stat(path);
		const selection: SelectedContext = {
			entries: [],
			missingEntryIds: [],
			read: ["src/main.ts"],
			outline: [],
			references: [],
		};
		const first = await contextProjectionKey(root, selection, undefined, () => true);
		await writeFile(path, "export const b = 2;\n");
		await utimes(path, metadata.atime, metadata.mtime);
		expect(await contextProjectionKey(root, selection, undefined, () => true)).not.toBe(first);
	});
});
