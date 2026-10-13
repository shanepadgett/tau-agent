# Handle rate limits and plan limits

When a provider refuses a request because of a rate limit or a plan's usage limit, Tau tries again or tells you when you can continue.

1. Run a prompt as usual:

   ```sh
   tau -p "Fix the failing test in src/math.js"
   ```

2. If stderr shows a line such as `Retry 1 in 2 s.`, wait. Tau calls the model again.
3. If the run fails with `Your ChatGPT plan reached its usage limit` or `Your Claude plan reached its usage limit`, open the usage page in the message to see your plan's usage. Run the prompt again after the reset time.

## What happens

- A rate limit, a dropped connection or a server error is tried again up to 4 times, after about 2, 4, 8 and 16 seconds. When the provider asks for a longer wait, Tau waits that long.
- Text the model sent before a failed call stays on stdout, but it is not part of the answer and the model does not see it again.
- When the provider asks for a wait longer than 2 minutes, the run fails and says how long to wait.
- A plan login (Claude, ChatGPT) that reaches its usage limit is not tried again. The message gives the reset time when the provider sends it, and the plan's usage page.

## Limits

- Errors that do not pass, such as a bad API key or a bad request, are not tried again. The run fails with the provider's message.
- The Claude usage-limit message is built from headers that Tau has not yet seen in a live reply.
