# Spikes

- A spike answers one question whose answer could change the plan. No question, no spike.
- It lives in `spikes/<name>/` and is self-contained: its own `package.json` and dependencies, nothing written outside its folder.
- `NOTES.md` states the question, what was tried, the result, and its limits (platforms tested, cases not covered). Keep it short.
- Record the result in `docs/plan/spikes.md` as a numbered entry: the question, then a bold **Result** line.
- Questions about the shipped product are tested in a compiled `tau` binary, not only under `bun run`.
- Spike code is reference only. `src/` never imports from `spikes/`; port what is needed and write it properly.
