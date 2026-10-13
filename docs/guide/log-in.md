# Log in to a model provider

`tau login` saves an API key or a subscription login, so Tau can use that provider's models.

1. Run:

   ```sh
   tau login
   ```

2. Choose the provider. The list shows how each one logs in: an API key, a Claude subscription, or a ChatGPT plan.
3. Follow the prompt:
   - For an API key, paste the key.
   - For a subscription, choose a browser on this machine, or a browser anywhere (Tau shows an address or a code).
4. To remove a saved login or key, run `tau logout` and choose the provider.

## What happens

- Tau saves the credential in `~/.tau/credentials.db`, which only your user can read.
- Tau refreshes a subscription login before it expires.
- Logging out of Sign in with ChatGPT also ends the login on OpenAI's side.

## Limits

- One credential per provider.
- Without a saved key, Tau reads the provider's environment variable, such as `OPENROUTER_API_KEY`.
