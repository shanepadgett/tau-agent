// Copies the spike's registration into Tau's own store, so `tau login` reuses the "Tau" app the
// spike registered instead of registering a second one. Prints no tokens.
import { homedir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Context, DateTime, Effect, Layer, Redacted } from "effect";
import { ChatgptAppTokens, CredentialStore, ProviderId } from "../../src/ai/credential.ts";
import { credentialStoreLayer } from "../../src/host/credential-store.ts";

const tauDirectory = join(homedir(), ".tau");
const hostIdPath = join(tauDirectory, "host-id");
const credentials = await Bun.file(`${import.meta.dir}/state/credentials.json`).json();
const hostId = (await Bun.file(`${import.meta.dir}/state/host-id.txt`).text()).trim();

if (await Bun.file(hostIdPath).exists()) throw new Error(`${hostIdPath} already exists; not replacing it.`);
await Bun.write(hostIdPath, `${hostId}\n`);

const tokens = ChatgptAppTokens.make({
  clientId: credentials.client_id,
  idToken: Redacted.make(credentials.id_token),
  access: Redacted.make(credentials.access_token),
  refresh: Redacted.make(credentials.refresh_token),
  expiresAt: DateTime.makeUnsafe(Date.parse(credentials.saved_at) + credentials.expires_in * 1000),
});

await Effect.runPromise(
  Effect.gen(function* () {
    const store = Context.get(yield* Layer.build(credentialStoreLayer(tauDirectory)), CredentialStore);
    yield* store.save(ProviderId.make("chatgpt"), tokens);
  }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
);

console.log(`Saved the chatgpt registration (${credentials.client_id.slice(0, 7)}…) and host ID in ${tauDirectory}.`);
