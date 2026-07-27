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
		expect(isContextEligiblePath("package-lock.json")).toBe(false);
		expect(isContextEligiblePath("packages/example/pnpm-lock.yaml")).toBe(false);
		expect(isContextEligiblePath("crates/example/Cargo.lock")).toBe(false);
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
		await writeFile(join(root, "src", "math.ts"), "export {};\n");
		await mkdir(join(root, ".pi", "contexts", "gameplay"), { recursive: true });
		await writeFile(
			join(root, ".pi", "contexts", "gameplay", "player.toml"),
			'name = "Player"\ndescription = "Player systems"\n\n[movement]\ndescription = "Player movement"\nread = []\noutline = ["src/player.ts"]\nreferences = ["src/math.ts"]\n',
		);

		expect(await loadContextEntries(root)).toMatchObject([
			{
				id: "gameplay/player/movement",
				tab: "gameplay",
				concept: "player",
				conceptName: "Player",
				name: "movement",
				read: [],
				outline: ["src/player.ts"],
				references: ["src/math.ts"],
			},
		]);
	});

	it("allows reference-only entries and rejects overlapping loading modes", async () => {
		const root = await project();
		const directory = join(root, ".pi", "contexts", "code");
		await mkdir(directory, { recursive: true });
		const path = join(directory, "source.toml");
		await writeFile(
			path,
			'name = "Source"\n\n[guide]\ndescription = "Source guide"\nread = []\noutline = []\nreferences = ["src/player.ts"]\n',
		);
		expect(await loadContextEntries(root)).toMatchObject([{ read: [], outline: [], references: ["src/player.ts"] }]);

		await writeFile(
			path,
			'name = "Source"\n\n[guide]\ndescription = "Source guide"\nread = ["src/player.ts"]\noutline = ["src/player.ts"]\nreferences = []\n',
		);
		await expect(loadContextEntries(root)).rejects.toThrow("multiple loading modes");
	});

	it("rejects unknown entry fields", async () => {
		const root = await project();
		const directory = join(root, ".pi", "contexts", "code");
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "source.toml"),
			'name = "Source"\n\n[guide]\ndescription = "Source guide"\nread = []\noutline = []\nreferences = ["src/player.ts"]\nanchor = ["src/player.ts"]\n',
		);
		await expect(loadContextEntries(root)).rejects.toThrow("Invalid context entry field");
	});
});
