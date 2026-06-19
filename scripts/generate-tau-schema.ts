import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTauSettingsSchema } from "../src/shared/settings/schema.ts";
import { discoverTauSettingsSpecs } from "../src/shared/settings/specs.ts";

const SCHEMA_PATH = resolve("schemas", "tau.schema.json");

const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("Usage: generate-tau-schema.ts [--write|--check]");

const specs = await discoverTauSettingsSpecs(process.cwd());
const content = `${JSON.stringify(buildTauSettingsSchema(specs), null, "\t")}\n`;

if (mode === "--write") {
	await writeFile(SCHEMA_PATH, content, "utf8");
} else {
	let current = "";
	try {
		current = await readFile(SCHEMA_PATH, "utf8");
	} catch {}
	if (current !== content) {
		throw new Error("schemas/tau.schema.json is stale. Run mise run generate-schema.");
	}
}

