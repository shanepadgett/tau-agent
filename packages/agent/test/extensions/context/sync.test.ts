import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectSyncEvidence,
	discoverDirectDependencies,
	formatEvidenceSection,
} from "../../../extensions/context/evidence.ts";
import { buildContextSyncTask, CONTEXT_SYNC_REQUIRED_TOOLS } from "../../../extensions/context/sync.ts";
import { discoverAgents } from "../../../extensions/subagent/agents.ts";
import type { GitRunner } from "../../../shared/git.ts";

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

function gitWithStatus(status: string): GitRunner {
	return {
		cwd: "/tmp",
		async run(args) {
			if (args[0] === "status") return status;
			if (args[0] === "diff") return "diff body";
			return "";
		},
	};
}

describe("context sync", () => {
	it("resolves one direct relative dependency", async () => {
		const root = await project();
		expect([...(await discoverDirectDependencies(root, [{ path: "src/player.ts", evidence: "" }]))]).toEqual([
			"src/math.ts",
		]);
	});

	it("formats overview evidence with uncovered dirty files", async () => {
		const root = await project();
		const evidence = await collectSyncEvidence(
			gitWithStatus("1 .M N... 100644 100644 100644 deadbeef deadbeef src/player.ts"),
			root,
			[],
		);
		const overview = formatEvidenceSection(evidence, "overview");
		expect(overview).toContain("src/player.ts");
		expect(overview).toContain("Uncovered changed files: 1");
		expect(formatEvidenceSection(evidence, "invariants")).toContain("Uncovered changed files");
	});

	it("reports holding invariants when dirty files already belong", async () => {
		const root = await project();
		await mkdir(join(root, ".pi", "contexts", "gameplay"), { recursive: true });
		await writeFile(
			join(root, ".pi", "contexts", "gameplay", "player.toml"),
			'name = "Player"\n\n[all]\ndescription = "Player code"\nfiles = ["src/player.ts"]\n',
		);
		const evidence = await collectSyncEvidence(
			gitWithStatus("1 .M N... 100644 100644 100644 deadbeef deadbeef src/player.ts"),
			root,
			[],
		);
		expect(formatEvidenceSection(evidence, "invariants")).toContain("invariants hold");
		expect(formatEvidenceSection(evidence, "catalog")).toContain("gameplay/player/all");
	});

	it("includes optional nudge in the subagent task", () => {
		expect(buildContextSyncTask("/repo")).not.toContain("Human nudge");
		expect(buildContextSyncTask("/repo", "  prefer infrastructure  ")).toContain(
			"Human nudge (soft steer, does not skip evidence or ladder):\nprefer infrastructure",
		);
	});

	it("loads the context-sync agent with required tools", async () => {
		const discovery = await discoverAgents(process.cwd(), true);
		const agent = discovery.agents.get("context-sync");
		expect(agent).toBeDefined();
		expect(agent?.tools).toEqual([...CONTEXT_SYNC_REQUIRED_TOOLS]);
		expect(agent?.description).toContain("meaningful uncommitted work");
	});
});
