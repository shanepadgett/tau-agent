import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

export type AstLanguage = "typeScript" | "tsx" | "odin" | "go" | "rust" | "cSharp" | "java" | "kotlin" | "swift";

export interface SourcePosition {
	line: number;
	column: number;
}

export interface SourceRange {
	startByte: number;
	endByte: number;
	start: SourcePosition;
	end: SourcePosition;
}

export interface OutlineEntry {
	role: "item" | "member";
	symbolType: string;
	name: string;
	range: SourceRange;
	signature: string;
	astKind: string;
	locator: string;
}

export interface OutlineItem extends OutlineEntry {
	isImport: boolean;
	isExported: boolean;
	members: Array<OutlineEntry & { isPublic: boolean }>;
}

export interface OutlineResult {
	path: string;
	language: AstLanguage;
	sourceFingerprint: string;
	byteLength: number;
	lineCount: number;
	diagnostics: { errorNodes: number; missingNodes: number };
	items: OutlineItem[];
}

export interface SymbolResult {
	path: string;
	language: AstLanguage;
	sourceFingerprint: string;
	range: SourceRange;
	source: string;
}

export interface AstClient {
	outline(path: string, language: AstLanguage, signal: AbortSignal | undefined): Promise<OutlineResult>;
	symbol(locator: string, signal: AbortSignal | undefined): Promise<SymbolResult>;
	shutdown(): Promise<void>;
}

type WorkerRequestPayload =
	| { operation: "handshake" }
	| { operation: "outline"; path: string; language: AstLanguage }
	| { operation: "symbol"; locator: string };

interface WorkerResponse {
	requestId: number;
	protocolVersion: number;
	success: boolean;
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string };
}

interface PendingRequest {
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
	removeAbortListener(): void;
}

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const STDERR_BYTES = 16 * 1024;

export class AstWorkerClient implements AstClient {
	private readonly command: string;
	private readonly args: readonly string[];
	private child: ChildProcessWithoutNullStreams | undefined;
	private startPromise: Promise<void> | undefined;
	private pending = new Map<number, PendingRequest>();
	private nextRequestId = 1;
	private incoming = Buffer.alloc(0);
	private stderr = "";

	constructor(
		command = fileURLToPath(
			new URL(
				`../../native/tau-ast/target/release/tau-ast${process.platform === "win32" ? ".exe" : ""}`,
				import.meta.url,
			),
		),
		args: readonly string[] = [],
	) {
		this.command = command;
		this.args = args;
	}

	async outline(path: string, language: AstLanguage, signal: AbortSignal | undefined): Promise<OutlineResult> {
		const result = await this.request({ operation: "outline", path, language }, signal);
		if (result.kind !== "outline") throw new Error("tau-ast returned the wrong result for outline");
		return result as unknown as OutlineResult;
	}

	async symbol(locator: string, signal: AbortSignal | undefined): Promise<SymbolResult> {
		const result = await this.request({ operation: "symbol", locator }, signal);
		if (result.kind !== "symbol") throw new Error("tau-ast returned the wrong result for symbol");
		return result as unknown as SymbolResult;
	}

	async shutdown(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		this.startPromise = undefined;
		this.rejectPending(new Error("tau-ast worker shut down"));
		child.stdin.end();
		if (child.exitCode !== null) return;
		await Promise.race([
			new Promise<void>((resolve) => child.once("exit", () => resolve())),
			new Promise<void>((resolve) => setTimeout(resolve, 250)),
		]);
		if (child.exitCode === null) child.kill();
	}

	private async request(
		request: WorkerRequestPayload,
		signal: AbortSignal | undefined,
	): Promise<Record<string, unknown>> {
		await this.ensureStarted();
		return this.send(request, signal);
	}

	private async ensureStarted(): Promise<void> {
		if (this.startPromise) {
			await this.startPromise;
			return;
		}
		if (this.child) return;
		this.startPromise ??= this.start().finally(() => {
			this.startPromise = undefined;
		});
		await this.startPromise;
	}

	private async start(): Promise<void> {
		const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		this.incoming = Buffer.alloc(0);
		this.stderr = "";
		child.stdout.on("data", (chunk: Buffer) => this.receive(child, chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = Buffer.from(`${this.stderr}${chunk.toString("utf8")}`)
				.subarray(-STDERR_BYTES)
				.toString("utf8");
		});
		child.on("error", (error) => this.fail(child, new Error(`Failed to start tau-ast: ${error.message}`)));
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
			this.fail(child, new Error(`tau-ast exited (${signal ?? code ?? "unknown"})${suffix}`), false);
		});
		try {
			const result = await this.send({ operation: "handshake" }, undefined);
			if (result.kind !== "handshake") throw new Error("tau-ast handshake returned the wrong result");
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.fail(child, failure);
			throw failure;
		}
	}

	private send(request: WorkerRequestPayload, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
		const child = this.child;
		if (!child) return Promise.reject(new Error("tau-ast worker is not running"));
		if (signal?.aborted) return Promise.reject(new Error("tau-ast request cancelled"));
		const requestId = this.nextRequestId++;
		const payload = Buffer.from(JSON.stringify({ ...request, requestId, protocolVersion: PROTOCOL_VERSION }));
		const frame = Buffer.allocUnsafe(payload.length + 4);
		frame.writeUInt32BE(payload.length, 0);
		payload.copy(frame, 4);

		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const onAbort = (): void => this.fail(child, new Error("tau-ast request cancelled"));
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(requestId, {
				resolve,
				reject,
				removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
			});
			child.stdin.write(frame, (error) => {
				if (error) this.fail(child, new Error(`Failed to write tau-ast request: ${error.message}`));
			});
		});
	}

	private receive(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
		if (this.child !== child) return;
		this.incoming = Buffer.concat([this.incoming, chunk]);
		while (this.incoming.length >= 4) {
			const length = this.incoming.readUInt32BE(0);
			if (length > MAX_FRAME_BYTES) {
				this.fail(child, new Error(`tau-ast response frame exceeds ${MAX_FRAME_BYTES} bytes`));
				return;
			}
			if (this.incoming.length < length + 4) return;
			const payload = this.incoming.subarray(4, length + 4);
			this.incoming = this.incoming.subarray(length + 4);
			let response: WorkerResponse;
			try {
				response = JSON.parse(payload.toString("utf8")) as WorkerResponse;
			} catch (error) {
				this.fail(child, new Error(`tau-ast returned malformed JSON: ${String(error)}`));
				return;
			}
			const pending = this.pending.get(response.requestId);
			if (!pending) {
				this.fail(child, new Error(`tau-ast returned unknown request id ${String(response.requestId)}`));
				return;
			}
			this.pending.delete(response.requestId);
			pending.removeAbortListener();
			if (response.protocolVersion !== PROTOCOL_VERSION) {
				const error = new Error(`tau-ast response used protocol ${response.protocolVersion}`);
				pending.reject(error);
				this.fail(child, error);
				return;
			}
			if (!response.success) {
				pending.reject(new Error(response.error?.message ?? response.error?.code ?? "tau-ast request failed"));
				continue;
			}
			if (!response.result || typeof response.result !== "object") {
				pending.reject(new Error("tau-ast response omitted its result"));
				continue;
			}
			pending.resolve(response.result);
		}
	}

	private fail(child: ChildProcessWithoutNullStreams, error: Error, kill = true): void {
		if (this.child !== child) return;
		this.child = undefined;
		this.incoming = Buffer.alloc(0);
		this.rejectPending(error);
		if (kill && child.exitCode === null) child.kill();
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			request.removeAbortListener();
			request.reject(error);
		}
		this.pending.clear();
	}
}
