import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TauExtensionSettingsSpec } from "./define.ts";
import { listSettingsFiles } from "./files.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export async function discoverTauSettingsSpecs(_cwd?: string): Promise<TauExtensionSettingsSpec[]> {
	const roots = [join(PACKAGE_ROOT, "extensions"), join(PACKAGE_ROOT, "shared")];
	const files = (await Promise.all(roots.map(listSettingsFiles))).flat();
	const specs: TauExtensionSettingsSpec[] = [];

	for (const file of files) {
		const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
		if (isSpec(module.default)) specs.push(module.default);
	}

	return specs.sort((left, right) => left.key.localeCompare(right.key));
}

function isSpec(value: unknown): value is TauExtensionSettingsSpec {
	return !!value && typeof value === "object" && "key" in value && "defaults" in value && "schema" in value;
}
