# Runtime Context

Supplies Soul with the local date and root directory snapshot. Both are captured together when a prompt baseline is created and refreshed after successful compaction. Reload, resume, and midnight do not change an existing baseline.

After changing this extension, run `/reload` before testing the new behavior.
