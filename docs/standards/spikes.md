# Spikes

- A spike answers one question whose answer could change the plan. No question, no spike.
- It lives in `spikes/<name>/` and is self-contained: its own `package.json` and dependencies, nothing written outside its folder.
- `NOTES.md` states the question, what was tried, the result, and its limits (platforms tested, cases not covered). Keep it short.
- When the result is built into `src/` or ruled out, delete the spike. Keep no log of finished spikes.
- Questions about the shipped product are tested in a compiled `tau` binary, not only under `bun run`.
- Spike code is reference only. `src/` never imports from `spikes/`; port what is needed and write it properly.
