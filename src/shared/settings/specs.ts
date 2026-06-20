import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TauExtensionSettingsSpec } from "./define.ts";

export async function discoverTauSettingsSpecs(cwd: string): Promise<TauExtensionSettingsSpec[]> {
	const roots = [join(cwd, "src", "extensions"), join(cwd, "src", "shared")];
	const files = (await Promise.all(roots.map(listSettingsFiles))).flat();
	const specs: TauExtensionSettingsSpec[] = [];

	for (const file of files) {
		const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
		if (isSpec(module.default)) specs.push(module.default);
	}

	return specs.sort((left, right) => left.key.localeCompare(right.key));
}

async function listSettingsFiles(root: string): Promise<string[]> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await listSettingsFiles(path)));
		else if (entry.isFile() && entry.name === "settings.ts") files.push(path);
	}
	return files.sort();
}

function isSpec(value: unknown): value is TauExtensionSettingsSpec {
	return !!value && typeof value === "object" && "key" in value && "defaults" in value && "schema" in value;
}
