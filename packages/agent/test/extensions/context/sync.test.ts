import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyContextSyncPlan,
	discoverDirectDependencies,
	normalizeContextSyncPlan,
	type SyncEvidence,
} from "../../../extensions/context/sync.ts";
import { loadContextEntries } from "../../../extensions/context/definitions.ts";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "tau-context-sync-"));
	roots.push(root);
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "player.ts"), 'import "./math";\n');
	await writeFile(join(root, "src", "math.ts"), "export const value = 1;\n");
	return root;
}

describe("context sync", () => {
	it("resolves one direct relative dependency", async () => {
		const root = await project();
		expect([...(await discoverDirectDependencies(root, [{ path: "src/player.ts", evidence: "" }]))]).toEqual([
			"src/math.ts",
		]);
	});

	it("accepts no-change with a reason", async () => {
		const root = await project();
		const evidence: SyncEvidence = {
			root,
			files: [],
			entries: [],
			dirtyExisting: new Set(),
			dependencies: new Set(),
			affectedIds: new Set(),
			affectedConcepts: new Set(),
			eligibleFiles: new Set(),
			missingPaths: new Set(),
			structuralPreviews: new Map(),
			worktreeSignature: "worktree",
			catalogSignature: "catalog",
		};
		expect(normalizeContextSyncPlan({ outcome: "no-change", reason: "Already useful" }, evidence)).toEqual({
			outcome: "no-change",
			reason: "Already useful",
		});
	});

	it("rejects no-change while a changed file is uncovered", async () => {
		const root = await project();
		const evidence: SyncEvidence = {
			root,
			files: [
				{
					id: 1,
					path: "src/player.ts",
					status: " M",
					kind: "modified",
					untracked: false,
					memberships: [],
					oldMemberships: [],
					evidence: "changed",
				},
			],
			entries: [],
			dirtyExisting: new Set(["src/player.ts"]),
			dependencies: new Set(),
			affectedIds: new Set(),
			affectedConcepts: new Set(),
			eligibleFiles: new Set(["src/player.ts"]),
			missingPaths: new Set(),
			structuralPreviews: new Map(),
			worktreeSignature: "worktree",
			catalogSignature: "catalog",
		};
		expect(() => normalizeContextSyncPlan({ outcome: "no-change", reason: "Skip" }, evidence)).toThrow(
			"no-change cannot leave uncovered changed files",
		);
	});

	it("applies multiple desired entries without losing concept metadata", async () => {
		const root = await project();
		const path = join(root, ".pi", "contexts", "gameplay", "player.toml");
		await mkdir(join(root, ".pi", "contexts", "gameplay"), { recursive: true });
		await writeFile(
			path,
			'name = "Player"\ndescription = "Player systems"\n\n[all]\ndescription = "All player code"\nfiles = ["src/player.ts"]\nanchors = ["src/math.ts"]\n',
		);
		const entries = await loadContextEntries(root);
		await applyContextSyncPlan(
			root,
			{
				outcome: "apply",
				reason: "Split durable scopes",
				changes: [
					{ action: "delete-entry", tab: "gameplay", concept: "player", entry: "all" },
					{
						action: "set-entry",
						tab: "gameplay",
						concept: "player",
						conceptName: "Player",
						conceptDescription: "Player systems",
						entry: "movement",
						description: "Player movement",
						files: ["src/player.ts", "src/math.ts"],
					},
				],
			},
			entries,
			async () => {
				expect(
					(await readdir(join(root, ".pi", "contexts", "gameplay"))).some((file) => file.endsWith(".tmp")),
				).toBe(false);
			},
		);
		const output = await readFile(path, "utf8");
		expect(output).toContain('name = "Player"');
		expect(output).toContain("[movement]");
		expect(output).not.toContain("[all]");
		expect(await loadContextEntries(root)).toMatchObject([
			{ name: "movement", files: ["src/player.ts"], anchors: ["src/math.ts"] },
		]);
	});

	it("preserves retained anchors and makes new membership eager", async () => {
		const root = await project();
		await writeFile(join(root, "src", "extra.ts"), "export {};\n");
		const path = join(root, ".pi", "contexts", "gameplay", "player.toml");
		await mkdir(join(root, ".pi", "contexts", "gameplay"), { recursive: true });
		await writeFile(
			path,
			'name = "Player"\ndescription = "Player systems"\n\n[movement]\ndescription = "Player movement"\nfiles = ["src/player.ts"]\nanchors = ["src/math.ts"]\n',
		);
		const entries = await loadContextEntries(root);
		await applyContextSyncPlan(
			root,
			{
				outcome: "apply",
				reason: "Add related source",
				changes: [
					{
						action: "set-entry",
						tab: "gameplay",
						concept: "player",
						conceptName: "Player",
						conceptDescription: "Player systems",
						entry: "movement",
						description: "Player movement",
						files: ["src/extra.ts", "src/math.ts", "src/player.ts"],
					},
				],
			},
			entries,
		);

		expect(await loadContextEntries(root)).toMatchObject([
			{
				files: ["src/extra.ts", "src/player.ts"],
				anchors: ["src/math.ts"],
			},
		]);
	});
});
