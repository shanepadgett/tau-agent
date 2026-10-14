/**
 * Runs a shell command on plain pipes: no terminal, clean lines. The command leads its own process
 * group, and killing it kills the group.
 */

import { Effect, Exit, Queue, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { ShellStart, Transport } from "./transport.ts";

const encoder = new TextEncoder();

export const spawnPipes = Effect.fn("spawnPipes")(function* (shell: ShellStart) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.make();
  const input = yield* Queue.unbounded<Uint8Array>();

  const command = ChildProcess.make("sh", ["-c", shell.command], {
    cwd: shell.directory,
    extendEnv: true,
    stdin: { stream: Stream.fromQueue(input), endOnDone: false },
    killSignal: "SIGKILL",
  });

  const child = yield* spawner.spawn(command).pipe(
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
  );

  const transport: Transport = {
    output: child.all.pipe(Stream.orDie),
    write: (text) => Queue.offer(input, encoder.encode(text)).pipe(Effect.asVoid),
    exitCode: child.exitCode.pipe(Effect.orDie),
    kill: Scope.close(scope, Exit.void),
  };

  return transport;
});
