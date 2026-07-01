import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freezeRuntimeContext } from "../../../src/extensions/soul/prompt.ts";

describe("soul prompt runtime context", () => {
	it("uses gitignore semantics for the root snapshot instead of hiding dot directories", () => {
		const root = mkdtempSync(join(tmpdir(), "tau-soul-prompt-"));

		try {
			runGit(root, "init", "--quiet");
			mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
			mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
			writeFileSync(join(root, ".gitignore"), "node_modules/\n");
			writeFileSync(join(root, ".pi", "extensions", "tool.ts"), "");
			writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");

			const snapshot = freezeRuntimeContext(root).rootSnapshot;

			expect(snapshot).toContain(".pi/");
			expect(snapshot).toContain(".pi/extensions/");
			expect(snapshot).not.toContain(".git/");
			expect(snapshot).not.toContain("node_modules/");
			expect(snapshot).not.toContain("node_modules/pkg/");
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});

function runGit(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status === 0) return;
	throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}
