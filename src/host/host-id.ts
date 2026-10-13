/** Keeps this machine's Sign in with ChatGPT host ID in `~/.tau/host-id`, apart from credentials so a copy of them never carries it. */

import { join } from "node:path";
import { Crypto, Effect, FileSystem } from "effect";

/** Returns the host ID saved in `tauDirectory`, creating it on first use. */
export const readOrCreateHostId = Effect.fn("readOrCreateHostId")(function* (tauDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = join(tauDirectory, "host-id");
  if (yield* fileSystem.exists(path)) return (yield* fileSystem.readFileString(path)).trim();

  // OpenAI accepts a `urn:uuid:` URI built from a UUIDv4.
  const hostId = `urn:uuid:${yield* (yield* Crypto.Crypto).randomUUIDv4()}`;
  yield* fileSystem.makeDirectory(tauDirectory, { recursive: true });
  yield* fileSystem.writeFileString(path, `${hostId}\n`);
  return hostId;
});
