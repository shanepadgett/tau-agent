import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface HelperResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type RunHelper = (args: string[], signal: AbortSignal | undefined, timeout: number) => Promise<HelperResult>;

const MACH_O_64_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

async function validExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		const handle = await open(path, "r");
		try {
			const magic = Buffer.alloc(MACH_O_64_MAGIC.length);
			const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
			return bytesRead === magic.length && magic.equals(MACH_O_64_MAGIC);
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

export function createNativeHelper(pi: Pick<ExtensionAPI, "exec">): RunHelper {
	let helperPromise: Promise<string> | undefined;
	let resolvedExecutable: string | undefined;

	async function buildHelper(signal: AbortSignal | undefined): Promise<string> {
		const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : undefined;
		if (!architecture) throw new Error(`Appshot does not support ${process.arch} macOS processes`);

		const sourcePath = fileURLToPath(new URL("capture.swift", import.meta.url));
		const source = await readFile(sourcePath);
		const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
		const cacheDirectory = join(homedir(), "Library", "Caches", "tau-agent", "appshot", architecture, sourceHash);
		const executablePath = join(cacheDirectory, "tau-appshot");
		if (await validExecutable(executablePath)) return executablePath;

		await rm(executablePath, { force: true });
		await mkdir(cacheDirectory, { recursive: true });
		const temporaryPath = `${executablePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const result = await pi.exec(
				"xcrun",
				[
					"swiftc",
					"-parse-as-library",
					"-target",
					`${architecture}-apple-macosx14.0`,
					sourcePath,
					"-o",
					temporaryPath,
				],
				{ signal, timeout: 120_000 },
			);
			if (result.code !== 0) {
				throw new Error(`Failed to build macOS screenshot helper: ${result.stderr.trim() || result.stdout.trim()}`);
			}
			await rename(temporaryPath, executablePath);
			return executablePath;
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	async function executable(signal: AbortSignal | undefined): Promise<string> {
		return (helperPromise ??= buildHelper(signal)
			.then((path) => {
				resolvedExecutable = path;
				return path;
			})
			.catch((error: unknown) => {
				helperPromise = undefined;
				throw error;
			}));
	}

	return async (args, signal, timeout) => {
		const path = await executable(signal);
		try {
			return await pi.exec(path, args, { signal, timeout });
		} catch (error) {
			if (!signal?.aborted && resolvedExecutable === path) {
				await rm(path, { force: true });
				resolvedExecutable = undefined;
				helperPromise = undefined;
			}
			throw error;
		}
	};
}
