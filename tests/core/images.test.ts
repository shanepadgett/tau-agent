/** Pictures: preparing them, placing them in the request and filling them in for the model. */

import { expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Exit, FileSystem } from "effect";
import { Prompt } from "effect/ai";
import { prepareImage } from "../../src/core/internal/images/prepare.ts";
import { resolveImages } from "../../src/core/internal/images/resolve-images.ts";
import { contextView } from "../../src/session/ContextView.ts";

const PIXEL = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

test("a PNG stays a PNG when it is prepared", async () => {
  const prepared = await Effect.runPromise(prepareImage(PIXEL));
  expect(prepared.mediaType).toBe("image/png");
  expect(prepared.bytes.length).toBeGreaterThan(0);
});

test("bytes that are not a picture fail", async () => {
  const exit = await Effect.runPromiseExit(prepareImage(new TextEncoder().encode("not a picture")));
  expect(Exit.isFailure(exit)).toBe(true);
});

const entries = (path: string) => [
  {
    number: 1,
    createdAt: 0,
    body: { type: "user", text: "see [Image 1]", images: [{ path, mediaType: "image/png" }] },
  },
];

const fileParts = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    message.role === "user" ? message.content.filter((part) => part.type === "file") : [],
  );

test("a user picture is a file part that points at its saved file", () => {
  const parts = fileParts(contextView("soul", entries("/tmp/a.png") as never));
  expect(parts).toHaveLength(1);
  expect(parts[0]?.data).toEqual(new URL("file:///tmp/a.png"));
});

const resolved = (path: string, canSeeImages: boolean) =>
  resolveImages(contextView("soul", entries(path) as never), { canSeeImages }).pipe(
    Effect.provide(BunFileSystem.layer),
    Effect.runPromise,
  );

test("a model that can see gets the picture's bytes", async () => {
  const path = `/tmp/tau-image-test-${crypto.randomUUID()}.png`;

  await Effect.runPromise(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) => fileSystem.writeFile(path, PIXEL)),
      Effect.provide(BunFileSystem.layer),
    ),
  );

  const parts = fileParts(await resolved(path, true));
  expect(parts[0]?.data).toEqual(PIXEL);
});

test("a model that cannot see gets a note, and a lost file gives a note too", async () => {
  expect(fileParts(await resolved("/tmp/none.png", false))).toHaveLength(0);
  expect(fileParts(await resolved("/tmp/lost-picture.png", true))).toHaveLength(0);
});
