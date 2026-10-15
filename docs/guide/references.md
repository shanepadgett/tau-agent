# Reference repositories

`/references` lists read-only clones in `~/.tau/references/<name>` and lets you clone a git URL, update, switch branch, open in `$VISUAL`/`$EDITOR`/`code`, or delete. The panel shows its keys.

Mark clones and press Enter to attach exactly those to the session. The agent is told their names and the folder, and can read them with its normal file access; Tau does not stop it from changing them. Tag a reference with `@name/`.

To reuse clones from an older Tau: `mv ~/.local/share/tau-agent/references ~/.tau/references`.
