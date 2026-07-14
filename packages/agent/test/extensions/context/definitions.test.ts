import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isContextEligiblePath,
	isSensitiveContextPath,
	loadContextEntries,
} from "../../../extensions/context/definitions.ts";

const temporaryDirectories: string[] = [];

afterEach(async () =>
	Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "tau-context-"));
	temporaryDirectories.push(root);
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "player.ts"), "export {};\n");
	return root;
}

describe("context definitions", () => {
	it("excludes temporary and non-system repository artifacts", () => {
		expect(isContextEligiblePath(".working/implementation-plan.md")).toBe(false);
		expect(isContextEligiblePath(".pi/contexts/core/settings.toml")).toBe(false);
		expect(isContextEligiblePath(".pi/tau/ideas.jsonl")).toBe(false);
		expect(isContextEligiblePath("LICENSE")).toBe(false);
		expect(isContextEligiblePath("packages/agent/index.ts")).toBe(true);
	});

	it("identifies sensitive files before context inspection", () => {
		expect(isSensitiveContextPath(".env")).toBe(true);
		expect(isSensitiveContextPath("config/.env.production")).toBe(true);
		expect(isSensitiveContextPath("certificates/release.pem")).toBe(true);
		expect(isSensitiveContextPath(".env.example")).toBe(false);
		expect(isSensitiveContextPath("src/environment.ts")).toBe(false);
	});

	it("maps folders, files, and TOML sections to tabs, concepts, and entries", async () => {
		const root = await project();
		await mkdir(join(root, ".pi", "contexts", "gameplay"), { recursive: true });
		await writeFile(
			join(root, ".pi", "contexts", "gameplay", "player.toml"),
			'name = "Player"\ndescription = "Player systems"\n\n[movement]\ndescription = "Player movement"\nfiles = ["src/player.ts"]\n',
		);

		expect(await loadContextEntries(root)).toMatchObject([
			{
				id: "gameplay/player/movement",
				tab: "gameplay",
				concept: "player",
				conceptName: "Player",
				name: "movement",
				files: ["src/player.ts"],
			},
		]);
	});
});
