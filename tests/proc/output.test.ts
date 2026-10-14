import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, type Scope } from "effect";
import { captureOutput, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "../../src/proc/Output.ts";

const withOutput = <A, E>(
  program: (path: string) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        return yield* program(`${directory}/output.log`);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

describe("bounded output capture", () => {
  for (const text of [
    "",
    "hello\n",
    "x".repeat(MAX_OUTPUT_BYTES),
    "line\n".repeat(MAX_OUTPUT_LINES),
  ]) {
    test(`keeps ${text.length} bytes at or below the limits without making a file`, () =>
      withOutput((path) =>
        Effect.gen(function* () {
          const capture = yield* captureOutput(path);
          yield* capture.accept(new TextEncoder().encode(text));
          expect(yield* capture.result).toEqual({ type: "whole", text });
          expect(yield* (yield* FileSystem.FileSystem).exists(path)).toBe(false);
        }),
      ));
  }

  test("spills all bytes, retains half at each end and creates a private file", () =>
    withOutput((path) =>
      Effect.gen(function* () {
        const text = `START${"x".repeat(MAX_OUTPUT_BYTES)}END`;
        const capture = yield* captureOutput(path);
        yield* capture.accept(new TextEncoder().encode(text.slice(0, 100)));
        yield* capture.accept(new TextEncoder().encode(text.slice(100)));
        const captured = yield* capture.result;
        expect(captured.type).toBe("cut");
        if (captured.type !== "cut") throw new Error("Expected cut output");
        expect(captured.start).toBe(text.slice(0, MAX_OUTPUT_BYTES / 2));
        expect(captured.end).toBe(text.slice(-MAX_OUTPUT_BYTES / 2));
        expect(captured.bytes).toBe(text.length);
        expect(captured.lines).toBe(1);
        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.readFileString(path)).toBe(text);
        expect((yield* fileSystem.stat(path)).mode & 0o777).toBe(0o600);
      }),
    ));

  test("counts a final unterminated line and keeps a rolling end after spilling", () =>
    withOutput((path) =>
      Effect.gen(function* () {
        const capture = yield* captureOutput(path);
        const text = `${"first\n".repeat(MAX_OUTPUT_LINES)}last`;
        yield* capture.accept(new TextEncoder().encode(text));
        yield* capture.accept(new TextEncoder().encode("-end"));
        const captured = yield* capture.result;
        if (captured.type !== "cut") throw new Error("Expected cut output");
        expect(captured.lines).toBe(MAX_OUTPUT_LINES + 1);
        expect(captured.start).toBe("first\n".repeat(MAX_OUTPUT_LINES / 2));
        expect(captured.end).toEndWith("last-end");
        expect(captured.end.split("\n")).toHaveLength(MAX_OUTPUT_LINES / 2);
        expect(yield* (yield* FileSystem.FileSystem).readFileString(path)).toBe(`${text}-end`);
      }),
    ));

  test("keeps UTF-8 characters whole across split chunks and byte cuts", () =>
    withOutput((path) =>
      Effect.gen(function* () {
        const bytes = new TextEncoder().encode(`a${"😀".repeat(MAX_OUTPUT_BYTES / 4 + 10)}z`);
        const capture = yield* captureOutput(path);

        for (let offset = 0; offset < bytes.length; offset += 997)
          yield* capture.accept(bytes.slice(offset, offset + 997));

        const captured = yield* capture.result;
        if (captured.type !== "cut") throw new Error("Expected cut output");
        expect(captured.start).toStartWith("a😀");
        expect(captured.end).toEndWith("😀z");
        expect(captured.start + captured.end).not.toContain("�");

        expect(new TextEncoder().encode(captured.start + captured.end).length).toBeLessThanOrEqual(
          MAX_OUTPUT_BYTES,
        );

        expect(yield* (yield* FileSystem.FileSystem).readFile(path)).toEqual(bytes);
      }),
    ));

  for (const existing of ["file", "link"]) {
    test(`refuses an existing ${existing} without changing its contents`, () =>
      withOutput((path) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const target = `${path}.target`;
          yield* fileSystem.writeFileString(target, "private");

          if (existing === "link") yield* fileSystem.symlink(target, path);
          else yield* fileSystem.writeFileString(path, "private");

          const capture = yield* captureOutput(path);

          const failed = yield* Effect.result(
            capture.accept(new TextEncoder().encode("x".repeat(MAX_OUTPUT_BYTES + 1))),
          );

          expect(failed._tag).toBe("Failure");
          expect(yield* fileSystem.readFileString(target)).toBe("private");
          expect(yield* fileSystem.readFileString(path)).toBe("private");
        }),
      ));
  }
});
