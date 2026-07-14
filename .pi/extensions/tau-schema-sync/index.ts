import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listSettingsFiles } from "../../../packages/agent/shared/settings/files.ts";

const execFileAsync = promisify(execFile);
const SETTINGS_ROOT = join("packages", "agent", "extensions");
const GENERATOR = join("packages", "agent", "scripts", "generate-tau-schema.ts");

type Hashes = Map<string, string>;

export default function tauSchemaSync(pi: ExtensionAPI): void {
	let baseline: Hashes | undefined;
	let run: Promise<string | undefined> | undefined;
	let pendingNotice: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		baseline = await hashSettingsFiles(ctx.cwd);
	});

	pi.on("tool_result", async (_event, ctx) => {
		const next = await hashSettingsFiles(ctx.cwd);
		if (baseline && sameHashes(baseline, next)) return;

		baseline ??= next;
		run ??= generateSchema(ctx.cwd)
			.then(() => {
				baseline = next;
				return "Tau schema regenerated: packages/agent/schemas/tau.schema.json";
			})
			.catch(() => undefined)
			.finally(() => {
				run = undefined;
			});

		pendingNotice = await run;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (run) pendingNotice = await run;
		if (!pendingNotice || !ctx.hasUI) return;
		ctx.ui.notify(pendingNotice, "info");
		pendingNotice = undefined;
	});
}

async function generateSchema(cwd: string): Promise<void> {
	await execFileAsync(process.execPath, ["--experimental-strip-types", GENERATOR, "--write"], {
		cwd,
		timeout: 15_000,
		encoding: "utf8",
	});
}

async function hashSettingsFiles(cwd: string): Promise<Hashes> {
	const root = join(cwd, SETTINGS_ROOT);
	const files = await listSettingsFiles(root);
	const hashes: Hashes = new Map();

	for (const file of files) {
		const content = await readFile(file);
		hashes.set(relative(cwd, file), createHash("sha256").update(content).digest("hex"));
	}

	return hashes;
}

function sameHashes(left: Hashes, right: Hashes): boolean {
	if (left.size !== right.size) return false;
	for (const [path, hash] of left) {
		if (right.get(path) !== hash) return false;
	}
	return true;
}
