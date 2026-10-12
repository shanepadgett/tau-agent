/** What a provider credential is, and the storage the AI layer needs to read and refresh it. */

import { Context, Schema, type Effect, type Option } from "effect";

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"));
export type ProviderId = typeof ProviderId.Type;

const Secret = Schema.RedactedFromValue(Schema.String);

export const ApiKey = Schema.TaggedStruct("ApiKey", { key: Secret });

export const OAuthTokens = Schema.TaggedStruct("OAuthTokens", {
  access: Secret,
  refresh: Secret,
  expiresAt: Schema.DateTimeUtcFromMillis,
});

export const Credential = Schema.Union([ApiKey, OAuthTokens]);
export type Credential = typeof Credential.Type;

export class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()(
  "CredentialStoreError",
  { path: Schema.String, cause: Schema.Defect() },
) {}

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly read: (
      provider: ProviderId,
    ) => Effect.Effect<Option.Option<Credential>, CredentialStoreError>;

    readonly save: (
      provider: ProviderId,
      credential: Credential,
    ) => Effect.Effect<void, CredentialStoreError>;

    readonly remove: (provider: ProviderId) => Effect.Effect<void, CredentialStoreError>;

    /**
     * Replaces `stale` with the result of `refresh`, one process at a time. When
     * another process already replaced `stale`, returns its credential without
     * calling `refresh`. Returns none when the credential was removed meanwhile.
     */
    readonly update: <E>(
      provider: ProviderId,
      stale: Credential,
      refresh: (stale: Credential) => Effect.Effect<Credential, E>,
    ) => Effect.Effect<Option.Option<Credential>, E | CredentialStoreError>;
  }
>()("tau/ai/CredentialStore") {}
