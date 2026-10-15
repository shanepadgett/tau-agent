/**
 * Logs in to a provider and saves the credential, and logs out. Every kind of login goes through
 * here: API keys, Claude and Codex OAuth, and Sign in with ChatGPT.
 */

import { Effect, Option, Schema } from "effect";
import { ApiKey, ChatgptAppTokens, CredentialStore } from "./Credential.ts";
import { logInChatgptApp, revokeChatgptApp } from "./internal/login/chatgpt-app.ts";
import { HostId, LoginPrompt } from "./internal/login/login-services.ts";
import { logInWithOAuth } from "./internal/login/oauth.ts";
import type { Provider } from "./Providers.ts";

export { HostId, type LoginMethod, LoginPrompt } from "./internal/login/login-services.ts";

/** Logs in to `provider` and saves the credential, replacing any saved one. */
export const logIn = Effect.fn("logIn")(function* (provider: Provider) {
  const store = yield* CredentialStore;
  const prompt = yield* LoginPrompt;
  const { auth, id } = provider;

  switch (auth.kind) {
    case "none":
      return;
    case "apiKey": {
      const key = yield* prompt.askSecret(`${id} API key`);
      return yield* store.save(id, ApiKey.make({ key }));
    }
    case "chatgptApp":
      return yield* logInChatgptApp(id, auth.app, yield* (yield* HostId).read);
    case "claudeSubscription":
    case "codexLogin": {
      const method = yield* prompt.chooseMethod(auth.oauth.headless);
      return yield* store.save(id, yield* logInWithOAuth(id, auth.oauth, method));
    }
  }
});

/**
 * Removes the saved credential of `provider`. A Sign in with ChatGPT login is also ended on OpenAI's
 * side; when that fails, the user is told how to end it by hand.
 */
export const logOut = Effect.fn("logOut")(function* (provider: Provider) {
  const store = yield* CredentialStore;

  if (provider.auth.kind === "chatgptApp") {
    const saved = Option.filter(yield* store.read(provider.id), Schema.is(ChatgptAppTokens));

    if (Option.isSome(saved)) {
      yield* revokeChatgptApp(provider.auth.app, saved.value).pipe(
        Effect.catchTag("HttpClientError", (error) =>
          LoginPrompt.use((prompt) =>
            prompt.show(
              `OpenAI did not confirm the logout (${error.message}). To end it on OpenAI's side, disconnect Tau in ChatGPT settings at chatgpt.com/settings/usage.`,
            ),
          ),
        ),
      );
    }
  }

  yield* store.remove(provider.id);
});
