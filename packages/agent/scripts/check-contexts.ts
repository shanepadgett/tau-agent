import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot, loadContextEntries } from "../extensions/context/definitions.ts";

function gitStatus(root: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			{ cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}

function uncommittedFiles(output: string): string[] {
	const records = output.split("\0");
	const files: string[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record || record.length < 4) continue;
		const status = record.slice(0, 2);
		const path = record.slice(3).replaceAll("\\", "/");
		if (status.includes("R") || status.includes("C")) index += 1;
		if (!status.includes("D")) files.push(path);
	}
	return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

try {
	const root = await findProjectRoot(process.cwd());
	const entries = await loadContextEntries(root);
	const memberships = new Map<string, string[]>();
	for (const entry of entries) {
		for (const file of entry.files) {
			const ids = memberships.get(file) ?? [];
			ids.push(entry.id);
			memberships.set(file, ids);
		}
	}

	const stale: Array<{ path: string; ids: string[] }> = [];
	for (const [path, ids] of memberships) {
		try {
			if (!(await stat(join(root, path))).isFile()) stale.push({ path, ids });
		} catch {
			stale.push({ path, ids });
		}
	}

	const uncovered = uncommittedFiles(await gitStatus(root)).filter(
		(path) => !path.startsWith(".pi/contexts/") && !memberships.has(path),
	);
	if (stale.length === 0 && uncovered.length === 0) process.exitCode = 0;
	else {
		const output = ["Context catalog validation failed."];
		if (stale.length > 0) {
			output.push("", "Stale context file references:");
			for (const item of stale.sort((a, b) => a.path.localeCompare(b.path))) {
				output.push(`- ${item.path} (${item.ids.sort().join(", ")})`);
			}
		}
		if (uncovered.length > 0) {
			output.push("", "Uncommitted files with no context membership:", ...uncovered.map((path) => `- ${path}`));
		}
		output.push("", "Run the context_sync tool to reconcile the context catalog.");
		console.error(output.join("\n"));
		process.exitCode = 1;
	}
} catch (error) {
	console.error(`Context catalog validation failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
