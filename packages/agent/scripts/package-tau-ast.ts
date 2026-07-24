import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rm, rmdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AstWorkerClient } from "../extensions/explore/ast-worker.ts";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACKAGE_ARTIFACT = join("packages", "agent", "native-bin", "darwin-arm64", "tau-ast");
const RELEASE_ARTIFACT = join(
	"packages",
	"agent",
	"native",
	"tau-ast",
	"target",
	"aarch64-apple-darwin",
	"release",
	"tau-ast",
);

interface PackedFile {
	path?: unknown;
	size?: unknown;
	mode?: unknown;
}

export async function stageTauAst(root: string, platform: NodeJS.Platform, arch: string): Promise<void> {
	if (platform !== "darwin" || arch !== "arm64")
		throw new Error(`tau-ast staging requires darwin-arm64; this host is ${platform}-${arch}`);
	const source = join(root, RELEASE_ARTIFACT);
	try {
		const sourceStat = await stat(source);
		if (!sourceStat.isFile() || sourceStat.size === 0) throw new Error("release artifact is empty");
	} catch (error) {
		throw new Error(
			`Missing locked Cargo release artifact at ${source}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const destination = join(root, PACKAGE_ARTIFACT);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(source, destination);
	await chmod(destination, 0o755);
}

async function smokeTauAst(root: string): Promise<void> {
	const command = join(root, PACKAGE_ARTIFACT);
	const fixture = join(root, "packages", "agent", "native", "tau-ast", "fixtures", "typescript.ts");
	const worker = new AstWorkerClient(command);
	try {
		const result = await worker.outline({ kind: "file", path: fixture, language: "typeScript" }, true, [], undefined);
		if (result.files.length !== 1 || !result.files[0]?.items.some((item) => item.name === "FileParser"))
			throw new Error(`tau-ast smoke outline returned no FileParser declaration for ${fixture}`);
	} catch (error) {
		throw new Error(`tau-ast smoke request failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await worker.shutdown();
	}
}

export function verifyPackedAgent(output: unknown): void {
	if (!Array.isArray(output)) throw new Error("npm pack --dry-run --json returned an invalid package list");
	const packedFiles = output.flatMap((entry): PackedFile[] => {
		if (!entry || typeof entry !== "object" || !("files" in entry) || !Array.isArray(entry.files)) return [];
		return entry.files as PackedFile[];
	});
	const matches = packedFiles.filter((file) => file.path === "native-bin/darwin-arm64/tau-ast");
	if (matches.length !== 1) throw new Error("Agent package must contain native-bin/darwin-arm64/tau-ast exactly once");
	const artifact = matches[0];
	if (!artifact || typeof artifact.size !== "number" || artifact.size <= 0)
		throw new Error("Packed native-bin/darwin-arm64/tau-ast is empty");
	if (typeof artifact.mode !== "number" || (artifact.mode & 0o111) === 0)
		throw new Error("Packed native-bin/darwin-arm64/tau-ast is not executable");
}

async function verifyPackedTauAst(root: string): Promise<void> {
	const { stdout } = await execFileAsync(
		"npm",
		["pack", "--dry-run", "--json", "--workspace", "@shanepadgett/tau-agent"],
		{ cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
	);
	let output: unknown;
	try {
		output = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`Could not parse npm pack JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	verifyPackedAgent(output);
}

export async function cleanTauAst(root: string): Promise<void> {
	const artifact = join(root, PACKAGE_ARTIFACT);
	await rm(artifact, { force: true });
	for (const directory of [dirname(artifact), dirname(dirname(artifact))]) {
		try {
			await rmdir(directory);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "ENOENT" &&
				(error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
			)
				throw error;
		}
	}
}

async function main(): Promise<void> {
	const action = process.argv[2];
	if (action === "stage") return stageTauAst(REPOSITORY_ROOT, process.platform, process.arch);
	if (action === "smoke") return smokeTauAst(REPOSITORY_ROOT);
	if (action === "verify-pack") return verifyPackedTauAst(REPOSITORY_ROOT);
	if (action === "clean") return cleanTauAst(REPOSITORY_ROOT);
	throw new Error("Usage: package-tau-ast.ts <stage|smoke|verify-pack|clean>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
