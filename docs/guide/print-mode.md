# Run a prompt from the terminal

Print mode runs one prompt, prints the answer and exits, so you can use Tau in scripts and pipes.

1. Set a model once (see [choose-a-model.md](choose-a-model.md)).
2. Run a prompt in the folder you want Tau to work in:

   ```sh
   tau -p "Fix the failing test in src/math.js"
   ```

3. To read the prompt from a file or another command, leave it out:

   ```sh
   cat task.md | tau -p
   ```

4. To continue a session, pass the session ID that the last run printed:

   ```sh
   tau -p --session 01a133e3-dc12-76cc-9464-9a9143c5fadd "Now add a test for it"
   ```

## What happens

- The answer goes to stdout. A line for each script Tau runs, and `Session: <id>` at the end, go to stderr. So `tau -p "..." > answer.md` keeps only the answer.
- Tau runs commands and changes files with your permissions. It does not ask first.
- Ctrl+C stops the run. The session keeps everything up to that point.
- When the model call fails with a rate limit or a server error, stderr shows a line before each retry (see [rate-limits.md](rate-limits.md)).
- Instructions from `AGENTS.md` files apply (see [write-agents-md.md](write-agents-md.md)).

## Limits

- The exit code is not zero when the run fails, reaches `maxTurns`, or stops at the model's output limit. At the output limit, the answer is cut short.
- There is no interactive mode yet.
