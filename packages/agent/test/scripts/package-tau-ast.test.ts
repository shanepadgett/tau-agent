import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTauAst, stageTauAst, verifyPackedAgent } from "../../scripts/package-tau-ast.ts";

const roots: string[] = [];

async function root(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "tau-ast-package-"));
	roots.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("tau-ast package staging", () => {
	it("stages an executable and removes the package artifact directories", async () => {
		const repository = await root();
		const source = join(repository, "packages/agent/native/tau-ast/target/aarch64-apple-darwin/release/tau-ast");
		await mkdir(join(source, "../"), { recursive: true });
		await writeFile(source, "binary");
		await stageTauAst(repository, "darwin", "arm64");
		const artifact = join(repository, "packages/agent/native-bin/darwin-arm64/tau-ast");
		expect((await stat(artifact)).mode & 0o111).not.toBe(0);
		await cleanTauAst(repository);
		await expect(access(join(repository, "packages/agent/native-bin"))).rejects.toThrow();
	});

	it("rejects staging on the wrong host", async () => {
		await expect(stageTauAst(await root(), "linux", "x64")).rejects.toThrow("requires darwin-arm64");
	});

	it("rejects packed output without the worker", () => {
		expect(() => verifyPackedAgent([{ files: [{ path: "README.md", size: 10, mode: 0o644 }] }])).toThrow(
			"exactly once",
		);
	});

	it("accepts one nonempty executable worker", () => {
		expect(() =>
			verifyPackedAgent([{ files: [{ path: "native-bin/darwin-arm64/tau-ast", size: 10, mode: 0o755 }] }]),
		).not.toThrow();
	});
});
