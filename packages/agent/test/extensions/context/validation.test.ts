import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../../../shared/git.ts";
import { formatContextValidationFailure, validateContextCatalog } from "../../../extensions/context/validation.ts";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("context validation", () => {
	it("reports uncovered changed files and honors ignore globs", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-context-validation-"));
		roots.push(root);
		await mkdir(join(root, ".pi", "contexts", "code"), { recursive: true });
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "covered.ts"), "export {};\n");
		await writeFile(join(root, "src", "anchored.ts"), "export {};\n");
		await writeFile(join(root, "src", "uncovered.ts"), "export {};\n");
		await writeFile(
			join(root, ".pi", "contexts", "code", "source.toml"),
			'name = "Source"\ndescription = "Source files"\n\n[all]\ndescription = "Covered source"\nfiles = ["src/covered.ts"]\nanchors = ["src/anchored.ts"]\n',
		);
		const git = {
			run: async () =>
				"1 .M N... 100644 100644 100644 abc abc src/covered.ts\0? src/anchored.ts\0? src/uncovered.ts\0? generated/output.ts\0",
		} as unknown as GitRunner;
		const result = await validateContextCatalog(git, root, ["generated/**"]);
		expect(result.uncovered).toEqual(["src/uncovered.ts"]);
		expect(formatContextValidationFailure(result)).toContain("/context-sync");
	});

	it("reports missing anchors as stale membership", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-context-validation-"));
		roots.push(root);
		await mkdir(join(root, ".pi", "contexts", "code"), { recursive: true });
		await writeFile(
			join(root, ".pi", "contexts", "code", "source.toml"),
			'name = "Source"\n\n[all]\ndescription = "Source files"\nfiles = []\nanchors = ["src/missing.ts"]\n',
		);
		const git = { run: async () => "" } as unknown as GitRunner;
		const result = await validateContextCatalog(git, root, []);
		expect(result.stale).toEqual([{ path: "src/missing.ts", ids: ["code/source/all"] }]);
	});
});
