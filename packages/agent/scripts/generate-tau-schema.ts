import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTauSettingsSchema } from "../shared/settings/schema.ts";
import { discoverTauSettingsSpecs } from "../shared/settings/specs.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = resolve(PACKAGE_ROOT, "schemas", "tau.schema.json");

const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("Usage: generate-tau-schema.ts [--write|--check]");

const specs = await discoverTauSettingsSpecs();
const content = `${JSON.stringify(buildTauSettingsSchema(specs), null, "\t")}\n`;

if (mode === "--write") {
	await writeFile(SCHEMA_PATH, content, "utf8");
} else {
	let current = "";
	try {
		current = await readFile(SCHEMA_PATH, "utf8");
	} catch {}
	if (current !== content) {
		throw new Error("packages/agent/schemas/tau.schema.json is stale. Run mise run generate-schema.");
	}
}
