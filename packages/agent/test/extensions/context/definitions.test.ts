import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadContextEntries, replaceContextFile, writeContextEntry } from "../../../extensions/context/definitions.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "tau-context-"));
	temporaryDirectories.push(root);
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "player.ts"), "export {};\n");
	return root;
}

describe("context definitions", () => {
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

	it("creates multiple entries in one concept file without replacing concept metadata", async () => {
		const root = await project();
		await writeContextEntry(
			root,
			{
				tab: "gameplay",
				concept: "player",
				conceptName: "Player",
				conceptDescription: "Player systems",
				entry: "movement",
				description: "Player movement",
				files: ["src/player.ts"],
			},
			false,
		);
		await writeContextEntry(
			root,
			{
				tab: "gameplay",
				concept: "player",
				conceptName: "Ignored replacement",
				conceptDescription: "Ignored replacement",
				entry: "input",
				description: "Player input",
				files: ["src/player.ts"],
			},
			false,
		);

		const entries = await loadContextEntries(root);
		expect(entries.map((entry) => entry.id).sort()).toEqual(["gameplay/player/input", "gameplay/player/movement"]);
		expect(entries.every((entry) => entry.conceptName === "Player")).toBe(true);
	});

	it("replaces a moved context file without leaving the old path", async () => {
		const root = await project();
		await writeFile(join(root, "src", "movement.ts"), "export {};\n");
		await writeContextEntry(
			root,
			{
				tab: "gameplay",
				concept: "player",
				conceptName: "Player",
				conceptDescription: "Player systems",
				entry: "movement",
				description: "Player movement",
				files: ["src/player.ts"],
			},
			false,
		);

		await replaceContextFile(root, "gameplay", "player", "movement", "src/player.ts", "src/movement.ts");

		expect((await loadContextEntries(root))[0]?.files).toEqual(["src/movement.ts"]);
	});
});
