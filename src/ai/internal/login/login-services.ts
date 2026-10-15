/** What a login needs from outside the AI layer: a way to talk to the user, the host ID, and its error. */

import { Context, type Effect, type PlatformError, type Redacted, Schema } from "effect";
import { ProviderId } from "../../Providers.ts";
import type { HeadlessLogin } from "../../Providers.ts";

export type LoginMethod = "browser" | "headless";

/** What a login shows and asks. The CLI implements it with the terminal and the system browser. */
export class LoginPrompt extends Context.Service<
  LoginPrompt,
  {
    /** Shows `url` and opens it in the browser when there is one. */
    readonly openBrowser: (url: string) => Effect.Effect<void>;
    readonly show: (text: string) => Effect.Effect<void>;
    readonly ask: (question: string) => Effect.Effect<string>;
    /** Asks for a secret, such as an API key, without showing what the user types. */
    readonly askSecret: (question: string) => Effect.Effect<Redacted.Redacted<string>>;
    /** Asks whether to log in with a browser on this machine or with `headless`. */
    readonly chooseMethod: (headless: HeadlessLogin) => Effect.Effect<LoginMethod>;
  }
>()("tau/ai/LoginPrompt") {}

/** The ID that names this machine to Sign in with ChatGPT. It stays the same across logins. */
export class HostId extends Context.Service<
  HostId,
  { readonly read: Effect.Effect<string, PlatformError.PlatformError> }
>()("tau/ai/HostId") {}

export class LoginFailed extends Schema.TaggedError<LoginFailed>()("LoginFailed", {
  provider: ProviderId,
  reason: Schema.Literals([
    "stateMismatch",
    "denied",
    "requestFailed",
    "deviceCodeExpired",
    "registrationFailed",
    "invalidIdToken",
    "planNotAllowed",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
