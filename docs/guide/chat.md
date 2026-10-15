# Chat with Tau in the terminal

Run `tau` with no `-p` to chat with Tau in your terminal: send prompts, watch the answer and each script as they happen, and cancel a run.

1. Set a model once (see [choose-a-model.md](choose-a-model.md)). The chat opens without one, but it does not send prompts until a model is set: the footer shows "no model set", and a prompt you send goes back into the input with a note on how to set one.
2. Open the chat in the folder you want Tau to work in:

   ```sh
   tau
   ```

3. Type a prompt and press Enter to send it. To add a line instead, press Shift+Enter, Ctrl+Enter, Alt+Enter or Ctrl+J.
4. To send a first prompt as the chat opens, give it on the command line:

   ```sh
   tau "Fix the failing test in src/math.js"
   ```

5. To continue a session, pass the session ID that Tau printed when you last quit:

   ```sh
   tau --session 01a133e3-dc12-76cc-9464-9a9143c5fadd
   ```

## Keys

| Key | What it does |
| --- | --- |
| Enter | Sends the prompt. During a run, the prompt waits until the run ends. |
| Shift+Enter, Ctrl+Enter, Alt+Enter, Ctrl+J | Adds a line to the prompt |
| Escape | Cancels the run |
| Ctrl+C | Cancels the run, or quits when no run is going |
| Ctrl+D | Quits |

## What happens

- The answer shows as Markdown while the model writes it. Each script shows on one line: ○ while it runs, ✓ when it passes, ✗ when it fails.
- Above the input, a line shows when a run is going, and one line shows each prompt that waits for it.
- When you cancel a run, the prompts that were waiting go back into the input, so you can change them and send them again.
- Directly above the input, the status strip lists problems that are true now, one line each: errors (✗, red) first, then warnings (!, yellow), then news with no mark (grey). Each line stays until its cause is gone, and long lines wrap. With no problems, the strip takes no space.
- Under the input, the footer shows the model and the keys you can use now. Nothing else shows there.
- When a run fails, the transcript shows "The run failed:" and the reason. The session keeps it, so a resumed session shows it too, and the model reads "The previous run failed: …" in its next call.
- A resumed session shows its earlier prompts, answers and scripts.
- To copy text, select it with the mouse. Tau copies it to the clipboard when you let go of the button. Over SSH, Tau copies through the terminal (OSC 52), which needs a terminal that allows it.
- When you quit, Tau prints `Session: <id>` so that you can continue the session later.
- Tau runs commands and changes files with your permissions. It does not ask first.

## Restart Tau into new code

Tau restarts the chat into new code with the same session and the same unsent input. A restart happens only when no run is going and no prompt waits.

- Type `/restart` and press Enter to restart now. During a run, the transcript shows "Tau restarts when this run ends." and the restart waits for it.
- When you run Tau from its source with `bun src/cli/main.ts` (in the Tau repository, `mise run dev`), Tau watches `src/`. After each change it builds the new code and checks that it starts. When the check passes, Tau restarts by itself. Set `"autoRestart": false` in `~/.tau/settings.json` to restart only with `/restart`; see [Change Tau's settings](settings.md).
- When the new code does not build or does not start, the chat keeps running on the old code, and the status strip shows the first line of the reason. The full reason goes to the log file (see "Logs" below). The line goes away, and the chat restarts, when new code passes its check.
- With `"autoRestart": false`, the status strip shows "New code is ready: send /restart." when new code passes its check.
- When the chat crashes, Tau starts it again on the same session. When new code crashes twice within 10 seconds of its start, Tau goes back to the code that ran before it. The status strip says so until newer code starts. When there is no older code, Tau stops and prints how to continue the session.

## Logs

Each Tau process writes its warnings and errors to its own file in `~/.tau/logs`, named for the time it started and its process ID, such as `2026-10-14T09-30-00-4121.jsonl`. Each line is one JSON object. Lines from a run have the session ID under `annotations.session`, so this finds the logs of one session:

```sh
rg -l 01a133e3-dc12-76cc-9464-9a9143c5fadd ~/.tau/logs
```

Each problem in the status strip is logged with its full detail, such as a build's whole error output. The supervisor, which restarts the chat into new code, writes its own file with the crashes it restarted. Tau removes log files older than 14 days when it starts. Set `logLevel` to keep more (see [Change Tau's settings](settings.md)).

## Limits

- Shift+Enter and Ctrl+Enter need a terminal that supports the kitty keyboard protocol, such as kitty, Ghostty or WezTerm. In other terminals, use Ctrl+J.
- Keys cannot be changed yet.
- The model comes from `--model` or your settings. You cannot change it in the chat yet.
- The chat does not show context use, cost or running process sessions yet.
- The status strip shows only problems with Tau's own code yet. Skipped skills folders, unreadable instruction files and an expired login are only in the log.
- A crash loses the unsent input. Only a restart keeps it.
- A released `tau` binary does not rebuild itself. `/restart` and the restart after a crash still work.
