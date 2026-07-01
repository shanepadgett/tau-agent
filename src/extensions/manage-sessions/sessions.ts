import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";

export type SessionScope = "current" | "all";

export interface ManagedSession {
	id: string;
	path: string;
	name: string;
	cwd: string;
	modified: Date;
	messageCount: number;
}

function getSessionsRoot(): string {
	return join(getAgentDir(), "sessions");
}

export function getArchiveRoot(): string {
	return join(getAgentDir(), "session-archive");
}

export async function listManagedSessions(
	cwd: string,
	scope: SessionScope,
	currentSessionFile?: string,
): Promise<{ active: ManagedSession[]; archive: ManagedSession[] }> {
	const currentSessionPath = currentSessionFile ? resolve(currentSessionFile) : undefined;
	const activeSessions = scope === "current" ? await SessionManager.list(cwd) : await SessionManager.listAll();
	const active = activeSessions
		.filter((session) => resolve(session.path) !== currentSessionPath)
		.map(toManagedSession);

	if (scope === "current") {
		// Mirrors Pi's default session dir encoding so archive paths match active paths.
		const safeCwd = `--${resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
		const archiveProjectDir = join(getArchiveRoot(), safeCwd);
		return {
			active,
			archive: (await SessionManager.list(cwd, archiveProjectDir)).map(toManagedSession),
		};
	}

	let archive: ManagedSession[] = [];
	try {
		const projectDirs = (await readdir(getArchiveRoot(), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(getArchiveRoot(), entry.name));

		for (const projectDir of projectDirs) {
			archive = archive.concat((await SessionManager.listAll(projectDir)).map(toManagedSession));
		}
	} catch {
		archive = [];
	}

	archive.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return { active, archive };
}

export async function archiveSession(sessionPath: string): Promise<void> {
	const relativePath = relative(getSessionsRoot(), sessionPath);
	if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
		throw new Error("Cannot archive session outside sessions root.");
	}

	const destination = join(getArchiveRoot(), relativePath);
	if (existsSync(destination)) {
		throw new Error("Archived session already exists.");
	}

	await mkdir(dirname(destination), { recursive: true });
	await rename(sessionPath, destination);
}

export async function unarchiveSession(sessionPath: string): Promise<void> {
	const relativePath = relative(getArchiveRoot(), sessionPath);
	if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
		throw new Error("Cannot unarchive session outside archive root.");
	}

	const destination = join(getSessionsRoot(), relativePath);
	if (existsSync(destination)) {
		throw new Error("Active session already exists.");
	}

	await mkdir(dirname(destination), { recursive: true });
	await rename(sessionPath, destination);
}

export async function deleteSessionFile(sessionPath: string): Promise<{ method: "trash" | "unlink" }> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { method: "unlink" };
	} catch (error) {
		const unlinkError = error instanceof Error ? error.message : String(error);
		const trashDetails = [trashResult.error?.message, trashResult.stderr?.trim().split("\n")[0]].filter(
			(detail) => detail && detail.length > 0,
		);
		const trashError = trashDetails.length > 0 ? ` (trash: ${trashDetails.join(" · ").slice(0, 200)})` : "";
		throw new Error(`Delete failed: ${unlinkError}${trashError}`);
	}
}

function toManagedSession(session: SessionInfo): ManagedSession {
	return {
		id: session.path,
		path: session.path,
		name: session.name ?? session.firstMessage,
		cwd: session.cwd,
		modified: session.modified,
		messageCount: session.messageCount,
	};
}
