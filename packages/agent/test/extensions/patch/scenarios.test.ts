import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { applyExactSourceMutations, applyPatch, type ApplyPatchSummary } from "../../../extensions/patch/executor.ts";

type Snapshot = Record<string, { type: "file"; content: string } | { type: "dir" }>;

interface ExpectedSummary {
	status: "completed" | "partial" | "failed";
	changes?: string[];
	failureCount?: number;
}

const scenariosDir = join(import.meta.dirname, "fixtures/scenarios");

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function snapshotDir(root: string): Promise<Snapshot> {
	const snapshot: Snapshot = {};
	if (!(await pathExists(root))) return snapshot;
	await snapshotDirRecursive(root, root, snapshot);
	return snapshot;
}

async function snapshotDirRecursive(root: string, dir: string, snapshot: Snapshot): Promise<void> {
	const entries = await readdir(dir);
	entries.sort((a, b) => a.localeCompare(b));

	for (const entry of entries) {
		const path = join(dir, entry);
		const info = await lstat(path);
		const key = relative(root, path);
		if (info.isDirectory()) {
			snapshot[key] = { type: "dir" };
			await snapshotDirRecursive(root, path, snapshot);
		} else if (info.isFile()) {
			snapshot[key] = { type: "file", content: await readFile(path, "utf8") };
		}
	}
}

function changeKey(change: ApplyPatchSummary["changes"][number]): string {
	if (change.move) return `move:${change.move.from}->${change.move.to}`;
	return `${change.kind}:${change.path}`;
}

async function scenarioNames(): Promise<string[]> {
	const entries = await readdir(scenariosDir);
	const names: string[] = [];
	for (const entry of entries) {
		const path = join(scenariosDir, entry);
		if ((await lstat(path)).isDirectory()) names.push(entry);
	}
	return names.sort((a, b) => a.localeCompare(b));
}

describe("patch fixture scenarios", async () => {
	for (const scenarioName of await scenarioNames()) {
		it(scenarioName, async () => {
			const scenarioDir = join(scenariosDir, scenarioName);
			const workspace = await mkdtemp(join(tmpdir(), "tau-patch-scenario-"));

			try {
				const inputDir = join(scenarioDir, "input");
				if (await pathExists(inputDir)) await cp(inputDir, workspace, { recursive: true });

				const patch = await readFile(join(scenarioDir, "patch.txt"), "utf8");
				const summary = await applyPatch(workspace, patch);

				expect(await snapshotDir(workspace)).toEqual(await snapshotDir(join(scenarioDir, "expected")));

				const expectedSummary = JSON.parse(
					await readFile(join(scenarioDir, "expected.json"), "utf8"),
				) as ExpectedSummary;
				expect(summary.status).toBe(expectedSummary.status);
				expect(summary.changes.map(changeKey)).toEqual(expectedSummary.changes ?? []);
				expect(summary.failures).toHaveLength(expectedSummary.failureCount ?? 0);
				for (const change of summary.changes) {
					if (change.kind === "delete") {
						expect(change.resultingFingerprint).toBeNull();
						continue;
					}
					const source = await readFile(join(workspace, change.path));
					expect(change.resultingFingerprint).toBe(`sha256:${createHash("sha256").update(source).digest("hex")}`);
				}
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		});
	}
});

describe("exact-source mutations", () => {
	it("preflights every fingerprint before writing any file", async () => {
		const workspace = await realpath(await mkdtemp(join(tmpdir(), "tau-exact-source-")));
		try {
			const first = join(workspace, "first.ts");
			const second = join(workspace, "second.ts");
			await writeFile(first, "first\n");
			await writeFile(second, "second\n");
			const fingerprint = (source: string) => `sha256:${createHash("sha256").update(source).digest("hex")}`;
			await expect(
				applyExactSourceMutations(workspace, [
					{ path: first, expectedFingerprint: fingerprint("first\n"), source: "changed first\n" },
					{ path: second, expectedFingerprint: fingerprint("stale\n"), source: "changed second\n" },
				]),
			).rejects.toThrow("Source changed before exact-source mutation");
			expect(await readFile(first, "utf8")).toBe("first\n");
			expect(await readFile(second, "utf8")).toBe("second\n");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
