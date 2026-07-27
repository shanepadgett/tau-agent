import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIRECTORY_PREFIX = "tau-tool-output-v1-";
const OWNER_FILE = ".tau-owner.json";

const TEMPORARY_OUTPUT_FILE_QUOTA_BYTES = 64 * 1024 * 1024;
const TEMPORARY_OUTPUT_SESSION_QUOTA_BYTES = 256 * 1024 * 1024;
const TEMPORARY_OUTPUT_ORPHAN_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function createTemporaryOutputStore(): TemporaryOutputStore {
	return new TemporaryOutputStore(
		tmpdir(),
		TEMPORARY_OUTPUT_FILE_QUOTA_BYTES,
		TEMPORARY_OUTPUT_SESSION_QUOTA_BYTES,
		TEMPORARY_OUTPUT_ORPHAN_LIFETIME_MS,
	);
}

interface OwnerMarker {
	kind: "tau-tool-output";
	version: 1;
	pid: number;
	createdAt: number;
}

export class TemporaryOutputError extends Error {
	readonly code: "quota" | "write";

	constructor(code: "quota" | "write", message: string) {
		super(message);
		this.name = "TemporaryOutputError";
		this.code = code;
	}
}

export class TemporaryOutputStore {
	private readonly baseDirectory: string;
	private readonly fileQuotaBytes: number;
	private readonly sessionQuotaBytes: number;
	private readonly orphanLifetimeMs: number;
	private started = false;
	private startPromise: Promise<void> | undefined;
	private directory: string | undefined;
	private directoryPromise: Promise<string> | undefined;
	private sessionBytes = 0;
	private readonly active = new Set<TemporaryOutputWriter>();
	private readonly creating = new Set<Promise<TemporaryOutputWriter>>();
	private shuttingDown = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(baseDirectory: string, fileQuotaBytes: number, sessionQuotaBytes: number, orphanLifetimeMs: number) {
		this.baseDirectory = baseDirectory;
		this.fileQuotaBytes = fileQuotaBytes;
		this.sessionQuotaBytes = sessionQuotaBytes;
		this.orphanLifetimeMs = orphanLifetimeMs;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.startPromise ??= this.removeStaleOrphans().then(() => {
			this.started = true;
		});
		try {
			await this.startPromise;
		} finally {
			this.startPromise = undefined;
		}
	}

	async createOutput(): Promise<TemporaryOutputWriter> {
		if (this.shuttingDown) throw new TemporaryOutputError("write", "Temporary output session is shutting down");
		const creation = this.createOutputFile();
		this.creating.add(creation);
		try {
			return await creation;
		} finally {
			this.creating.delete(creation);
		}
	}

	private async createOutputFile(): Promise<TemporaryOutputWriter> {
		await this.start();
		if (this.shuttingDown) throw new TemporaryOutputError("write", "Temporary output session is shutting down");
		this.directoryPromise ??= (async () => {
			const directory = join(this.baseDirectory, `${DIRECTORY_PREFIX}${randomUUID()}`);
			try {
				await mkdir(directory, { mode: 0o700 });
				const marker = {
					kind: "tau-tool-output",
					version: 1,
					pid: process.pid,
					createdAt: Date.now(),
				} satisfies OwnerMarker;
				const markerFile = await open(
					join(directory, OWNER_FILE),
					constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
					0o600,
				);
				try {
					await markerFile.writeFile(JSON.stringify(marker));
				} finally {
					await markerFile.close();
				}
				return directory;
			} catch (error) {
				await rm(directory, { recursive: true, force: true });
				throw error;
			}
		})();
		const directory = await this.directoryPromise;
		this.directory = directory;

		const partialPath = join(directory, `${randomUUID()}.partial`);
		let file;
		try {
			file = await open(partialPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		} catch (error) {
			throw new TemporaryOutputError("write", `Cannot create temporary output: ${String(error)}`);
		}
		const writer = new TemporaryOutputWriter(this, file, partialPath, partialPath.replace(/\.partial$/, ".txt"));
		this.active.add(writer);
		return writer;
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shutdownPromise = this.performShutdown();
		try {
			await this.shutdownPromise;
		} finally {
			this.shutdownPromise = undefined;
		}
	}

	private async performShutdown(): Promise<void> {
		this.shuttingDown = true;
		await Promise.allSettled(this.creating);
		for (const writer of this.active) await writer.abort();
		const directory = this.directory;
		this.directory = undefined;
		this.sessionBytes = 0;
		this.started = false;
		this.startPromise = undefined;
		this.directoryPromise = undefined;
		if (directory) await rm(directory, { recursive: true, force: true });
		this.shuttingDown = false;
	}

	reserve(writer: TemporaryOutputWriter, bytes: number): void {
		if (writer.byteLength + bytes > this.fileQuotaBytes) {
			throw new TemporaryOutputError(
				"quota",
				`Temporary output exceeds the ${this.fileQuotaBytes}-byte per-file quota`,
			);
		}
		if (this.sessionBytes + bytes > this.sessionQuotaBytes) {
			throw new TemporaryOutputError(
				"quota",
				`Temporary output exceeds the ${this.sessionQuotaBytes}-byte per-session quota`,
			);
		}
		writer.byteLength += bytes;
		this.sessionBytes += bytes;
	}

	release(writer: TemporaryOutputWriter): void {
		this.sessionBytes = Math.max(0, this.sessionBytes - writer.byteLength);
		writer.byteLength = 0;
		this.active.delete(writer);
	}

	complete(writer: TemporaryOutputWriter): void {
		this.active.delete(writer);
	}

	private async removeStaleOrphans(): Promise<void> {
		let directory;
		try {
			directory = await opendir(this.baseDirectory);
		} catch {
			return;
		}
		for await (const entry of directory) {
			if (!entry.isDirectory() || !entry.name.startsWith(DIRECTORY_PREFIX)) continue;
			const path = join(this.baseDirectory, entry.name);
			try {
				const metadata = await stat(path);
				if (Date.now() - metadata.mtimeMs < this.orphanLifetimeMs) continue;
				const marker = JSON.parse(await readFile(join(path, OWNER_FILE), "utf8")) as Partial<OwnerMarker>;
				if (marker.kind !== "tau-tool-output" || marker.version !== 1 || typeof marker.pid !== "number") continue;
				try {
					process.kill(marker.pid, 0);
					continue;
				} catch (error) {
					if (!isErrorCode(error, "ESRCH")) continue;
				}
				await rm(path, { recursive: true, force: true });
			} catch {
				// An untrusted or concurrently changing directory is not ours to remove.
			}
		}
	}
}

export class TemporaryOutputWriter {
	private readonly store: TemporaryOutputStore;
	private readonly file: Awaited<ReturnType<typeof open>>;
	private readonly partialPath: string;
	private readonly completePath: string;
	byteLength = 0;
	private closed = false;

	constructor(
		store: TemporaryOutputStore,
		file: Awaited<ReturnType<typeof open>>,
		partialPath: string,
		completePath: string,
	) {
		this.store = store;
		this.file = file;
		this.partialPath = partialPath;
		this.completePath = completePath;
	}

	async write(text: string): Promise<void> {
		if (this.closed) throw new TemporaryOutputError("write", "Temporary output is already closed");
		const buffer = Buffer.from(text);
		try {
			this.store.reserve(this, buffer.byteLength);
			let offset = 0;
			while (offset < buffer.byteLength) {
				const result = await this.file.write(buffer, offset, buffer.byteLength - offset);
				if (result.bytesWritten === 0) throw new Error("write returned zero bytes");
				offset += result.bytesWritten;
			}
		} catch (error) {
			await this.abort();
			if (error instanceof TemporaryOutputError) throw error;
			throw new TemporaryOutputError("write", `Cannot write temporary output: ${String(error)}`);
		}
	}

	async finish(): Promise<string> {
		if (this.closed) throw new TemporaryOutputError("write", "Temporary output is already closed");
		this.closed = true;
		try {
			await this.file.close();
			await rename(this.partialPath, this.completePath);
			this.store.complete(this);
			return this.completePath;
		} catch (error) {
			this.closed = false;
			await this.abort();
			throw new TemporaryOutputError("write", `Cannot complete temporary output: ${String(error)}`);
		}
	}

	async abort(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			await this.file.close().catch(() => {});
		}
		await rm(this.partialPath, { force: true }).catch(() => {});
		await rm(this.completePath, { force: true }).catch(() => {});
		this.store.release(this);
	}
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
