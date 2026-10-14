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

- The exit code is not zero when the run fails, reaches `maxTurns`, stops at the model's output limit, ends because the model sent the same failing call 3 times in a row, or ends because the project's checks still fail (see [project-checks.md](project-checks.md)). At the output limit, the answer is cut short.
- Shell output and script results over 50 KB (51,200 bytes) or 2,000 lines keep half at the start and half at the end. The warning says “Output shortened. Full output saved at `<path>`. Search that file or print less.” If script output was already discarded, it says “Retained output” instead of “Full output”. The model can search the saved file with `sh`.
- Output files live in `$TMPDIR/tau/<session>/`, or the OS default temporary folder when `TMPDIR` is unset. Directories are private (`0700`), files are private (`0600`), and Tau does not remove them. The OS may remove them; a saved session still keeps its preview text.
- Shell output files keep the whole stream received before exit, timeout or interruption. Script console capture stops at 10 MB (10,485,760 bytes), 65,536 entries, or a message too large to format safely. The script continues, but later console messages are discarded. Returned script output is also limited to 10 MB; script output files keep only what the interpreter returned. Discarded script output cannot be recovered. These limits do not bound all script allocations or oversized returned-value formatting.
- When output cannot be saved, the call fails with a storage error. Check the output folder's permissions and free disk space.
- There is no interactive mode yet.
