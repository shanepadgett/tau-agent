# Turn Budget

Adds soft turn budget hints for Tau sessions.

Turn Budget helps agents spend fewer provider cycles by nudging them to batch related tool work. It counts
tool-using turns per user prompt, sends visible steering messages at configured intervals, and extends the soft cap
instead of blocking work.

## Settings

- `enabled`: defaults to `true`
- `turnLimit`: defaults to `30`
- `nudgeEveryTurns`: defaults to `5`
- `softCapIncrement`: defaults to `10`
