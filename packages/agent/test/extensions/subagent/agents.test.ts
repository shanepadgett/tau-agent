import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, findProjectAgentsDir } from "../../../extensions/subagent/agents.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(): Promise<{ root: string; cwd: string; agents: string }> {
	const root = await mkdtemp(join(tmpdir(), "tau-subagent-agents-"));
	temporaryDirectories.push(root);
	const cwd = join(root, "nested", "cwd");
	const agents = join(root, ".pi", "tau", "agents");
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agents, { recursive: true })]);
	return { root, cwd, agents };
}

describe("subagent discovery", () => {
	it("loads built-ins and uses the nearest trusted project override", async () => {
		const paths = await project();
		await writeFile(
			join(paths.agents, "scout.md"),
			"---\nname: scout\ndescription: Project scout\ntools:\n  - read\n---\n\nProject-only prompt.\n",
		);

		expect(await findProjectAgentsDir(paths.cwd)).toBe(paths.agents);
		const trusted = await discoverAgents(paths.cwd, true);
		expect(trusted.agents.get("scout")?.description).toBe("Project scout");
		expect(trusted.agents.get("scout")?.names).toEqual(["scout"]);
		expect(trusted.agents.get("generalist")?.model).toBe("openai-codex/gpt-5.6-sol");
		expect(trusted.agents.get("generalist")?.thinking).toBe("high");
		expect(trusted.agents.has("web-research")).toBe(true);

		const untrusted = await discoverAgents(paths.cwd, false);
		expect(untrusted.agents.get("scout")?.description).not.toBe("Project scout");
	});

	it("blocks a malformed higher-precedence definition without blocking unrelated agents", async () => {
		const paths = await project();
		await writeFile(
			join(paths.agents, "scout.md"),
			"---\nname: scout\ndescription: Broken\ntools:\n  - subagent\nextra: nope\n---\n\nprompt\n",
		);

		const discovery = await discoverAgents(paths.cwd, true);
		expect(discovery.agents.has("scout")).toBe(false);
		expect(discovery.invalid.get("scout")?.[0]?.reason).toContain("unsupported field");
		expect(discovery.invalid.get("scout")?.[0]?.reason).toContain("forbidden");
		expect(discovery.agents.has("web-research")).toBe(true);
	});

	it("invalidates duplicate names within one scope", async () => {
		const paths = await project();
		const definition = (description: string) =>
			`---\nname: duplicate\ndescription: ${description}\ntools:\n  - read\n---\n\nprompt\n`;
		await Promise.all([
			writeFile(join(paths.agents, "one.md"), definition("One")),
			writeFile(join(paths.agents, "two.md"), definition("Two")),
		]);

		const discovery = await discoverAgents(paths.cwd, true);
		expect(discovery.agents.has("duplicate")).toBe(false);
		expect(discovery.invalid.get("duplicate")).toHaveLength(2);
	});

	it("loads model and thinking overrides", async () => {
		const paths = await project();
		await writeFile(
			join(paths.agents, "custom.md"),
			"---\nname: custom\ndescription: Custom\ntools:\n  - read\nmodel: openai-codex/gpt-5.6-sol\nthinking: medium\n---\n\nprompt\n",
		);

		const definition = (await discoverAgents(paths.cwd, true)).agents.get("custom");
		expect(definition?.model).toBe("openai-codex/gpt-5.6-sol");
		expect(definition?.thinking).toBe("medium");
	});

	it("loads and validates display-name pools", async () => {
		const paths = await project();
		await Promise.all([
			writeFile(
				join(paths.agents, "named.md"),
				"---\nname: named\ndescription: Named\ntools:\n  - read\nnames:\n  - Beacon\n  - Compass\n---\n\nprompt\n",
			),
			writeFile(
				join(paths.agents, "duplicate.md"),
				"---\nname: duplicate-names\ndescription: Broken names\ntools:\n  - read\nnames:\n  - Echo\n  - Echo\n---\n\nprompt\n",
			),
		]);

		const discovery = await discoverAgents(paths.cwd, true);
		expect(discovery.agents.get("named")?.names).toEqual(["Beacon", "Compass"]);
		expect(discovery.invalid.get("duplicate-names")?.[0]?.reason).toContain("names must be unique");
	});
});
