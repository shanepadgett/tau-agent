/** Lists the providers Tau can sign in to and signs the user in or out. The CLI gives the real service; a test gives a fake. */

import { Context, type Effect } from "effect";
import type { SignInState, VendorWays, Way } from "../ai/Connections.ts";
import type { CredentialStoreError } from "../ai/Credential.ts";
import type { LoginPrompt } from "../ai/Login.ts";

/** What a login asks of its user; the dialog supplies it. */
export type ConnectPrompt = LoginPrompt["Service"];

/** Why a login or logout did not finish, in words for the user. */
export type ConnectFailure = { readonly message: string };

export class Connections extends Context.Service<
  Connections,
  {
    /** The vendors with a way to sign in, by name, and whether each is signed in. */
    readonly vendors: Effect.Effect<readonly VendorWays[], CredentialStoreError>;
    /** Signs in by `way`, asking and showing through `prompt`, and saves the credential. */
    readonly logIn: (
      way: Way,
      prompt: LoginPrompt["Service"],
    ) => Effect.Effect<void, ConnectFailure>;
    /** Removes the saved credential of `way`'s provider. */
    readonly logOut: (
      way: Way,
      prompt: LoginPrompt["Service"],
    ) => Effect.Effect<void, ConnectFailure>;
  }
>()("tau/core/Connections") {}

// The dialog takes these from here, not from the AI layer.
export type ConnectVendor = VendorWays;
export type ConnectWay = Way;
export type ConnectSignIn = SignInState;
