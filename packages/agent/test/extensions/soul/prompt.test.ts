import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildRokPrompt,
	fingerprintRuntimeSnapshot,
	formatLocalDateKey,
	formatLocalDisplayDate,
	formatRuntimeContextMessage,
	freezeRuntimeContext,
} from "../../../extensions/soul/prompt.ts";

describe("soul prompt runtime context", () => {
	it("keeps only CWD in the system prompt and formats hidden local facts deterministically", () => {
		const runtime = { cwd: "/work", rootSnapshot: ["src/", "src/index.ts"] };
		const prompt = buildRokPrompt({ cwd: "/work" }, runtime);
		expect(prompt).toContain("Current working directory: /work");
		expect(prompt).not.toContain("Current date:");
		expect(prompt).not.toContain("Root directory snapshot");
		const date = new Date(2026, 6, 14, 12);
		expect(formatLocalDateKey(date)).toBe("2026-07-14");
		expect(formatLocalDisplayDate(date)).toBe("14 July 2026");
		expect(formatRuntimeContextMessage("14 July 2026", runtime.rootSnapshot)).toBe(
			"Current local date: 14 July 2026\nRoot directory snapshot (depth 2):\n- src/\n- src/index.ts",
		);
		expect(fingerprintRuntimeSnapshot(runtime)).toHaveLength(64);
	});

	it("is byte-stable when specialist tools have no prompt metadata", () => {
		const runtime = { cwd: "/work", rootSnapshot: [] };
		const core = { cwd: "/work", selectedTools: ["read", "load_tools"], toolSnippets: { read: "Read files" } };
		const before = buildRokPrompt(core, runtime);
		for (const names of [
			["webfetch", "websearch", "codesearch"],
			["image_gen"],
			["list_windows", "screenshot_window", "activate_app"],
		]) {
			expect(buildRokPrompt({ ...core, selectedTools: [...core.selectedTools, ...names] }, runtime)).toBe(before);
		}
	});
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
