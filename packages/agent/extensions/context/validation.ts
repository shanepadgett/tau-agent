import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunner } from "../../shared/git.ts";
import { isContextEligiblePath, isSensitiveContextPath, loadContextEntries } from "./definitions.ts";

export interface ContextValidationResult {
	stale: Array<{ path: string; ids: string[] }>;
	uncovered: string[];
}

export async function validateContextCatalog(
	git: GitRunner,
	root: string,
	ignoreGlobs: readonly string[],
): Promise<ContextValidationResult> {
	const entries = await loadContextEntries(root);
	const memberships = new Map<string, string[]>();
	for (const entry of entries)
		for (const file of entry.files) memberships.set(file, [...(memberships.get(file) ?? []), entry.id]);

	const stale: Array<{ path: string; ids: string[] }> = [];
	for (const [path, ids] of memberships) {
		if (!isContextEligiblePath(path, ignoreGlobs)) continue;
		try {
			if (!(await stat(join(root, path))).isFile()) stale.push({ path, ids });
		} catch {
			stale.push({ path, ids });
		}
	}

	const status = await git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root });
	const records = status.split("\0");
	const dirty = new Set<string>();
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		if (record.startsWith("? ")) {
			dirty.add(record.slice(2).replaceAll("\\", "/"));
			continue;
		}
		const fields = record.split(" ");
		const state = fields[1] ?? "..";
		if (record.startsWith("1 ") && !state.includes("D")) {
			dirty.add(fields.slice(8).join(" ").replaceAll("\\", "/"));
		} else if (record.startsWith("2 ")) {
			if (!state.includes("D")) dirty.add(fields.slice(9).join(" ").replaceAll("\\", "/"));
			index += 1;
		} else if (record.startsWith("u ")) {
			dirty.add(fields.slice(10).join(" ").replaceAll("\\", "/"));
		}
	}
	const uncovered = [...dirty]
		.filter(
			(path) => !isSensitiveContextPath(path) && isContextEligiblePath(path, ignoreGlobs) && !memberships.has(path),
		)
		.sort((left, right) => left.localeCompare(right));
	return { stale: stale.sort((left, right) => left.path.localeCompare(right.path)), uncovered };
}

export function formatContextValidationFailure(result: ContextValidationResult): string | undefined {
	if (result.stale.length === 0 && result.uncovered.length === 0) return undefined;
	const output = ["Context catalog validation failed."];
	if (result.stale.length)
		output.push(
			"",
			"Stale context file references:",
			...result.stale.map((item) => `- ${item.path} (${item.ids.sort().join(", ")})`),
		);
	if (result.uncovered.length)
		output.push("", "Changed files with no context membership:", ...result.uncovered.map((path) => `- ${path}`));
	output.push("", "Run context_sync to reconcile the context catalog.");
	return output.join("\n");
}
