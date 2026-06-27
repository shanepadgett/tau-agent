import { spawn } from "node:child_process";

const CAP_BYTES = 2 * 1024 * 1024;

export interface RipgrepResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutCapped: boolean;
	stderrCapped: boolean;
}

export function runRipgrep(args: string[], options: { cwd: string; signal?: AbortSignal }): Promise<RipgrepResult> {
	return new Promise((resolve) => {
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let stdoutCapped = false;
		let stderrCapped = false;
		const child = spawn("rg", args, { cwd: options.cwd, shell: false, signal: options.signal });

		child.stdout.on("data", (chunk: Buffer) => {
			const next = Buffer.concat([stdout, chunk]);
			stdout = next.subarray(0, CAP_BYTES);
			stdoutCapped ||= next.length > CAP_BYTES;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const next = Buffer.concat([stderr, chunk]);
			stderr = next.subarray(0, CAP_BYTES);
			stderrCapped ||= next.length > CAP_BYTES;
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			resolve({
				exitCode: null,
				stdout: "",
				stderr: error.code === "ENOENT" ? "rg not found" : error.message,
				stdoutCapped: false,
				stderrCapped: false,
			});
		});
		child.on("close", (exitCode) => {
			resolve({
				exitCode,
				stdout: stdout.toString("utf8"),
				stderr: stderr.toString("utf8"),
				stdoutCapped,
				stderrCapped,
			});
		});
	});
}
