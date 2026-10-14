# Questions

Open questions for the user. Each is removed as soon as it is answered.

- **Does a failed run become a session entry?** ([work/diagnostics.md](work/diagnostics.md)) Today the chat shows "The run failed: …" but the transcript does not keep it, so a resumed session does not show it. Recommendation: yes, a `run-failed` entry with the shown text, because the user saw it and the model may need it. It changes the session format, so it needs a migration.
