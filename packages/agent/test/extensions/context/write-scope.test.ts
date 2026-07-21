import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../../../shared/git.ts";
import {
	isContextCatalogPath,
	restoreOutsideContextMutations,
	snapshotOutsideContext,
} from "../../../extensions/context/write-scope.ts";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function gitWithStatus(
	status: string,
	options: { tracked?: ReadonlySet<string>; headContent?: Map<string, string> } = {},
): GitRunner {
	const tracked = options.tracked ?? new Set<string>();
	const headContent = options.headContent ?? new Map<string, string>();
	return {
		cwd: "/tmp",
		async run(args, runOptions = {}) {
			if (args[0] === "status") return status;
			if (args[0] === "ls-files") {
				const path = args[args.length - 1] ?? "";
				if (tracked.has(path)) return path;
				return runOptions.optional ? "" : "";
			}
			if (args[0] === "restore") {
				const path = args[args.length - 1] ?? "";
				const content = headContent.get(path);
				const root = runOptions.cwd;
				if (!root) throw new Error("restore requires cwd");
				if (content === undefined) {
					if (runOptions.optional) return "";
					throw new Error(`missing HEAD content for ${path}`);
				}
				await writeFile(join(root, path), content);
				return "";
			}
			return "";
		},
	};
}

describe("context write scope", () => {
	it("classifies catalog paths only under .pi/contexts", () => {
		expect(isContextCatalogPath(".pi/contexts/code/source.toml")).toBe(true);
		expect(isContextCatalogPath(".pi/contexts")).toBe(true);
		expect(isContextCatalogPath("src/main.ts")).toBe(false);
		expect(isContextCatalogPath(".pi/settings.json")).toBe(false);
	});

	it("restores newly dirtied non-context files and keeps catalog edits", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-context-scope-"));
		roots.push(root);
		await mkdir(join(root, ".pi", "contexts", "code"), { recursive: true });
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "main.ts"), "export const before = 1;\n");
		await writeFile(join(root, ".pi", "contexts", "code", "source.toml"), 'name = "Source"\n');

		const before = await snapshotOutsideContext(gitWithStatus(""), root);
		expect(before.size).toBe(0);

		await writeFile(join(root, "src", "main.ts"), "export const after = 2;\n");
		await writeFile(join(root, "src", "extra.ts"), "export {};\n");
		await writeFile(join(root, ".pi", "contexts", "code", "source.toml"), 'name = "Updated"\n');

		const violations = await restoreOutsideContextMutations(
			gitWithStatus(
				"1 .M N... 100644 100644 100644 a a src/main.ts\0? src/extra.ts\0? .pi/contexts/code/source.toml",
				{
					tracked: new Set(["src/main.ts"]),
					headContent: new Map([["src/main.ts", "export const before = 1;\n"]]),
				},
			),
			root,
			before,
		);
		expect(violations).toEqual(["src/extra.ts", "src/main.ts"]);
		expect(await readFile(join(root, "src", "main.ts"), "utf8")).toBe("export const before = 1;\n");
		expect(await readFile(join(root, ".pi", "contexts", "code", "source.toml"), "utf8")).toBe('name = "Updated"\n');
		await expect(readFile(join(root, "src", "extra.ts"), "utf8")).rejects.toThrow();
	});

	it("restores previously dirty outside files to their pre-run content", async () => {
		const root = await mkdtemp(join(tmpdir(), "tau-context-scope-"));
		roots.push(root);
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "main.ts"), "export const before = 1;\n");
		const before = await snapshotOutsideContext(
			gitWithStatus("1 .M N... 100644 100644 100644 a a src/main.ts"),
			root,
		);
		await writeFile(join(root, "src", "main.ts"), "export const mutated = 2;\n");
		const violations = await restoreOutsideContextMutations(
			gitWithStatus("1 .M N... 100644 100644 100644 a a src/main.ts"),
			root,
			before,
		);
		expect(violations).toEqual(["src/main.ts"]);
		expect(await readFile(join(root, "src", "main.ts"), "utf8")).toBe("export const before = 1;\n");
	});
});
