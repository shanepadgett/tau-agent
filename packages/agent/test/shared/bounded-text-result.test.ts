import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedTextResultBuilder } from "../../shared/bounded-text-result.ts";
import { TemporaryOutputStore } from "../../shared/temporary-output-store.ts";

const roots: string[] = [];

async function store(fileQuota = 1024 * 1024, sessionQuota = 4 * 1024 * 1024): Promise<TemporaryOutputStore> {
	const root = await mkdtemp(join(tmpdir(), "tau-bounded-result-test-"));
	roots.push(root);
	return new TemporaryOutputStore(root, fileQuota, sessionQuota, 1);
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded text results", () => {
	it("keeps complete visible blocks and streams exact overflow to a session file", async () => {
		const outputStore = await store();
		const builder = new BoundedTextResultBuilder(outputStore, "completeBlocks");
		const blocks = Array.from({ length: 80 }, (_, index) => `src/file-${index}.ts\n${"declaration\n".repeat(80)}`);
		for (const [index, block] of blocks.entries())
			await builder.appendBlock(`file-${index}`, `src/file-${index}.ts`, block);
		await builder.appendRequiredBlock("summary", "summary: all 80 files processed");

		const result = await builder.finish();
		expect(result.overflow.truncated).toBe(true);
		expect(result.overflow.fullOutputComplete).toBe(true);
		expect(result.visibleUnitIds.length).toBeGreaterThan(0);
		expect(result.visibleUnitIds.length).toBeLessThan(blocks.length);
		expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(50 * 1024);
		expect(result.content).toContain("summary: all 80 files processed");
		const path = result.overflow.temporaryPath;
		if (!path) throw new Error("overflow path missing");
		expect(await readFile(path, "utf8")).toBe(`${blocks.join("\n\n")}\n\nsummary: all 80 files processed`);

		await outputStore.shutdown();
		await expect(readFile(path, "utf8")).rejects.toThrow();
		await outputStore.shutdown();
	});

	it("uses one session directory for concurrent overflow files", async () => {
		const outputStore = await store();
		const writers = await Promise.all(Array.from({ length: 20 }, () => outputStore.createOutput()));
		await Promise.all(writers.map((writer) => writer.write("output")));
		await Promise.all(writers.map((writer) => writer.finish()));
		const directories = (await readdir(roots[0] ?? "")).filter((entry) => entry.startsWith("tau-tool-output-v1-"));
		expect(directories).toHaveLength(1);
		await Promise.all([outputStore.shutdown(), outputStore.shutdown()]);
		expect(await readdir(roots[0] ?? "")).toEqual([]);
	});

	it("deletes incomplete output after cancellation and fails closed at disk quota", async () => {
		const outputStore = await store(256, 512);
		const cancelled = new BoundedTextResultBuilder(outputStore, "head");
		await cancelled.append("line\n".repeat(3000));
		await cancelled.abort();
		const directories = await readdir(roots[0] ?? "");
		const session = directories.find((entry) => entry.startsWith("tau-tool-output-v1-"));
		if (!session) throw new Error("session output directory missing");
		expect((await readdir(join(roots[0] ?? "", session))).filter((entry) => !entry.startsWith(".tau"))).toEqual([]);

		const quota = new BoundedTextResultBuilder(outputStore, "completeBlocks");
		await quota.appendBlock("one", "one.ts", "x".repeat(60 * 1024));
		const result = await quota.finish();
		expect(result.overflow).toMatchObject({ truncated: true, fullOutputComplete: false, failure: "quota" });
		expect(result.overflow.temporaryPath).toBeUndefined();
		expect(result.content).toContain("disk quota exceeded");
		await outputStore.shutdown();
	});

	it("removes only old marked orphan directories with dead owners", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-bounded-orphan-test-"));
		roots.push(root);
		const orphan = join(root, "tau-tool-output-v1-orphan");
		const unmarked = join(root, "tau-tool-output-v1-unmarked");
		await mkdir(orphan);
		await mkdir(unmarked);
		await writeFile(
			join(orphan, ".tau-owner.json"),
			JSON.stringify({ kind: "tau-tool-output", version: 1, pid: 2_147_483_647, createdAt: 0 }),
		);
		const old = new Date(0);
		await Promise.all([utimes(orphan, old, old), utimes(unmarked, old, old)]);

		const outputStore = new TemporaryOutputStore(root, 1024, 4096, 1);
		await outputStore.start();
		expect(await readdir(root)).toEqual(["tau-tool-output-v1-unmarked"]);
		await outputStore.shutdown();
	});
});
