/** Captures command output with bounded memory and spills the whole stream to a private file. */

import { Effect, FileSystem, type PlatformError, Ref, Schema, Scope } from "effect";

const KIBIBYTE = 1024;
const MAX_OUTPUT_KIBIBYTES = 50;
export const MAX_OUTPUT_BYTES = MAX_OUTPUT_KIBIBYTES * KIBIBYTE;
export const MAX_OUTPUT_LINES = 2_000;
const END_BYTES = MAX_OUTPUT_BYTES / 2;
const END_LINES = MAX_OUTPUT_LINES / 2;
const NEWLINE = 10;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BYTE = 0x80;
const PRIVATE_FILE_MODE = 0o600;

export const CapturedOutput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("whole"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("cut"),
    start: Schema.String,
    end: Schema.String,
    path: Schema.String,
    bytes: Schema.Int,
    lines: Schema.Int,
  }),
]);

export type CapturedOutput = typeof CapturedOutput.Type;

type OutputCapture = {
  readonly accept: (chunk: Uint8Array) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly result: Effect.Effect<CapturedOutput>;
};

type Counts = {
  readonly bytes: number;
  readonly newlines: number;
  readonly last: number | undefined;
};

type CaptureState =
  | { readonly type: "memory"; readonly whole: Uint8Array; readonly counts: Counts }
  | {
      readonly type: "spilling";
      readonly start: Uint8Array;
      readonly end: Uint8Array;
      readonly counts: Counts;
      readonly file: FileSystem.File;
    };

/** The caller supplies an unused path in a directory it owns. The file survives the scope. */
export const captureOutput = Effect.fn("captureOutput")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;

  const state = yield* Ref.make<CaptureState>({
    type: "memory",
    whole: new Uint8Array(),
    counts: { bytes: 0, newlines: 0, last: undefined },
  });

  const accept = Effect.fn("OutputCapture.accept")(function* (chunk: Uint8Array) {
    const before = yield* Ref.get(state);
    const counts = countChunk(before.counts, chunk);

    if (before.type === "spilling") {
      yield* before.file.writeAll(chunk);
      yield* Ref.set(state, { ...before, counts, end: keepEnd(joinBytes(before.end, chunk)) });
      return;
    }

    const whole = joinBytes(before.whole, chunk);

    if (counts.bytes <= MAX_OUTPUT_BYTES && lineCount(counts) <= MAX_OUTPUT_LINES) {
      yield* Ref.set(state, { type: "memory", whole, counts });
      return;
    }

    const file = yield* fileSystem
      .open(path, {
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
        noFollow: true,
      })
      .pipe(Effect.provideService(Scope.Scope, scope));

    yield* file.writeAll(whole);

    yield* Ref.set(state, {
      type: "spilling",
      start: keepStart(whole),
      end: keepEnd(whole),
      counts,
      file,
    });
  }, Effect.uninterruptible);

  const captured: OutputCapture = {
    accept,
    result: Ref.get(state).pipe(Effect.map((received) => capturedOutput(received, path))),
  };

  return captured;
});

const joinBytes = (first: Uint8Array, second: Uint8Array) => {
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
};

const countChunk = (before: Counts, chunk: Uint8Array): Counts => {
  let newlines = before.newlines;
  for (const byte of chunk) if (byte === NEWLINE) newlines++;
  return { bytes: before.bytes + chunk.length, newlines, last: chunk.at(-1) ?? before.last };
};

const lineCount = (counts: Counts) =>
  counts.newlines + (counts.bytes > 0 && counts.last !== NEWLINE ? 1 : 0);

const keepStart = (whole: Uint8Array) => {
  let end = Math.min(whole.length, END_BYTES);
  let lines = 0;

  for (let index = 0; index < end; index++) {
    if (whole[index] === NEWLINE) lines++;

    if (lines === END_LINES) {
      end = index + 1;
      break;
    }
  }

  while (end > 0 && isContinuation(whole[end])) end--;
  return whole.slice(0, end);
};

const keepEnd = (whole: Uint8Array) => {
  let start = Math.max(0, whole.length - END_BYTES);
  let lines = whole.at(-1) === NEWLINE ? 0 : 1;

  for (let index = whole.length - 1; index >= start; index--) {
    if (whole[index] === NEWLINE) lines++;

    if (lines > END_LINES) {
      start = index + 1;
      break;
    }
  }

  while (start < whole.length && isContinuation(whole[start])) start++;
  return whole.slice(start);
};

const isContinuation = (byte: number | undefined) =>
  byte !== undefined && (byte & CONTINUATION_MASK) === CONTINUATION_BYTE;

const capturedOutput = (received: CaptureState, path: string): CapturedOutput => {
  const decoder = new TextDecoder();
  if (received.type === "memory") return { type: "whole", text: decoder.decode(received.whole) };

  return {
    type: "cut",
    start: decoder.decode(received.start),
    end: decoder.decode(received.end),
    path,
    bytes: received.counts.bytes,
    lines: lineCount(received.counts),
  };
};
