import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_DIR_NAME = ".pi";

export const TAU_SCHEMA_URL =
	"https://raw.githubusercontent.com/shanepadgett/tau-agent/refs/heads/main/schemas/tau.schema.json";

export function globalTauSettingsPath(): string {
	return join(getAgentDir(), "tau", "settings.json");
}

export async function projectTauSettingsPath(cwd: string): Promise<string> {
	return join(await resolveProjectRoot(cwd), CONFIG_DIR_NAME, "tau", "settings.json");
}

export async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveProjectRoot(cwd: string): Promise<string> {
	const start = resolve(cwd);
	let current = start;
	while (true) {
		if (resolve(current) !== resolve(homedir()) && (await isProjectRoot(current))) return current;
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

async function isProjectRoot(path: string): Promise<boolean> {
	return (await exists(join(path, ".git"))) || (await exists(join(path, CONFIG_DIR_NAME, "tau", "settings.json")));
}
