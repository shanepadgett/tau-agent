import { Effect } from "effect";
import { alive, descendants, signal } from "../shared/ps.ts";

const decoder = new TextDecoder();

type Handle = { readonly proc: Bun.Subprocess; readonly terminal: Bun.Terminal; readonly output: () => string };

// The tree is killed when the enclosing Scope closes: success, failure or
// interruption. Release runs uninterruptibly.
export const openSession = (cmd: string[]) =>
	Effect.acquireRelease(
		Effect.sync((): Handle => {
			let output = "";
			const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_t, bytes) => void (output += decoder.decode(bytes)) });
			const proc = Bun.spawn(cmd, { terminal, detached: true, env: { ...process.env, PS1: "$ " } });
			return { proc, terminal, output: () => output };
		}),
		(handle) => killTree(handle),
	);

export const waitFor = Effect.fnUntraced(function* (handle: Handle, text: string) {
	while (!handle.output().includes(text)) yield* Effect.sleep("20 millis");
});

const killTree = Effect.fnUntraced(function* ({ proc, terminal }: Handle) {
	const children = descendants(proc.pid);
	for (const pid of children) signal(pid, "SIGTERM");
	yield* Effect.sleep("200 millis");
	for (const pid of children) if (alive(pid)) signal(pid, "SIGKILL");
	proc.kill("SIGTERM");
	yield* Effect.promise(() => proc.exited).pipe(
		Effect.timeoutOrElse({ duration: "500 millis", orElse: () => Effect.sync(() => proc.kill("SIGKILL")) }),
	);
	yield* Effect.promise(() => proc.exited);
	terminal.close();
});
