/**
 * Keeps the host ID for Sign in with ChatGPT in `~/.tau/host-id`. The file is separate from the
 * credentials, so a copy of the credentials does not include it.
 */

import { join } from "node:path";
import { Crypto, Effect, FileSystem, Layer } from "effect";
import { HostId } from "../ai/Login.ts";
import { TauHome } from "../database/TauHome.ts";

/** Reads the host ID from Tau's home folder, and makes it on first use. */
export const hostIdLayer = Layer.effect(
  HostId,
  Effect.gen(function* () {
    const { directory } = yield* TauHome;
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const path = join(directory, "host-id");

    const read = Effect.gen(function* () {
      if (yield* fileSystem.exists(path)) return (yield* fileSystem.readFileString(path)).trim();

      // OpenAI accepts a `urn:uuid:` URI built from a UUIDv4.
      const hostId = `urn:uuid:${yield* crypto.randomUUIDv4()}`;
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(path, `${hostId}\n`);
      return hostId;
    });

    return HostId.of({ read });
  }),
);
