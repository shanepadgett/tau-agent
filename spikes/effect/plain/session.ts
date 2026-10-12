import { alive, descendants, signal } from "../shared/ps.ts";

const decoder = new TextDecoder();

export type Session = AsyncDisposable & {
	readonly pid: number;
	write(text: string): void;
	waitFor(text: string, signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
};

// `await using session = openSession(...)` kills the tree on scope exit,
// including when an abort makes the body throw.
export function openSession(cmd: string[]): Session {
	let output = "";
	const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_t, bytes) => void (output += decoder.decode(bytes)) });
	const proc = Bun.spawn(cmd, { terminal, detached: true, env: { ...process.env, PS1: "$ " } });
	let closing: Promise<void> | undefined;
	const close = () => (closing ??= killTree(proc, terminal));
	return {
		pid: proc.pid,
		write: (text) => terminal.write(text),
		async waitFor(text, abort) {
			while (!output.includes(text)) {
				abort?.throwIfAborted();
				await Bun.sleep(20);
			}
		},
		close,
		[Symbol.asyncDispose]: close,
	};
}

async function killTree(proc: Bun.Subprocess, terminal: Bun.Terminal) {
	const children = descendants(proc.pid);
	for (const pid of children) signal(pid, "SIGTERM");
	await Bun.sleep(200);
	for (const pid of children) if (alive(pid)) signal(pid, "SIGKILL");
	proc.kill("SIGTERM");
	const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]);
	if (!exited) proc.kill("SIGKILL");
	await proc.exited;
	terminal.close();
}
