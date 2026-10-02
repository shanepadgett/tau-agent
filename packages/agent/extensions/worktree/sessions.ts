import { realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Repository, Workspace } from "./workspaces.ts";
import { saveWorkspaceRecord } from "./workspaces.ts";
import { exists } from "../../shared/settings/paths.ts";

export async function prepareWorkspaceSession(
	ctx: ExtensionCommandContext,
	repository: Repository,
	workspace: Workspace,
	conversation: "fresh" | "continue" | "resume",
	thinkingLevel: NonNullable<ExtensionCommandContext["thinkingLevel"]>,
): Promise<string> {
	if (conversation === "resume") {
		const associated = workspace.record?.sessionPath;
		if (associated && (await exists(associated))) {
			const session = SessionManager.open(associated);
			const cwd = await realpath(session.getCwd());
			const path = relative(workspace.path, cwd);
			if (path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path)) {
				throw new Error("Saved session belongs to another workspace.");
			}
			return associated;
		}
		const sessions = await SessionManager.list(workspace.path);
		const recent = sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime())[0];
		if (recent) return recent.path;
	}
	const parentSession = ctx.sessionManager.getSessionFile();
	const target = SessionManager.create(workspace.path, undefined, { parentSession });
	const header = target.getHeader();
	const sessionPath = target.getSessionFile();
	if (!header || !sessionPath) throw new Error("Could not prepare a persistent workspace session.");
	if (ctx.model) target.appendModelChange(ctx.model.provider, ctx.model.id);
	target.appendThinkingLevelChange(thinkingLevel);
	target.appendSessionInfo(workspace.name);
	const branch = conversation === "continue" ? ctx.sessionManager.getBranch() : [];
	const setup = target.getBranch();
	const last = branch.at(-1);
	const entries = [
		...branch,
		...setup.map((entry, index) => (index === 0 ? { ...entry, parentId: last?.id ?? null } : entry)),
	];
	// Pi documents JSONL headers and entry trees. Explicit serialization also supports empty
	// chats and --no-session; copying getBranch() preserves the selected leaf, not alternatives.
	await writeFile(sessionPath, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	if (workspace.record) await saveWorkspaceRecord(repository, { ...workspace.record, sessionPath });
	return sessionPath;
}
