# bash-toggle

Local Tau extension for toggling the agent `bash` tool during a session.

Run `/bash` to disable or enable agent bash access. When disabled, Tau removes `bash`, enables Pi's first-party `grep`, `find`, and `ls` tools, blocks any stale bash tool call that still slips through, and shows `bash off` in the Tau footer.

User shell commands with `!` and `!!` are not affected.
