# Runtime Context

Supplies Soul with the local date and root directory snapshot. Both are captured on the first prompt of a session and refreshed after successful compaction. Reload, resume, and midnight do not change them.

After changing this extension, run `/reload` before testing the new behavior.
