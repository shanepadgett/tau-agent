# Explore

Explore is Tau's first-party filesystem exploration extension.

It exists so agents can inspect paths, discover files, search text, and read file contents with compact model payloads and readable tool rows. Repeated reads avoid resending content the agent already saw, including files supplied by autoread, while changed files return useful diffs or current source.

Agents invoke it with `ls`, `find`, `grep`, and `read`. Users run `/read-stats` to see estimated token and cost savings for the session.
