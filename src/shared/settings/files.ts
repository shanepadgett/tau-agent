import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function listSettingsFiles(root: string): Promise<string[]> {
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
