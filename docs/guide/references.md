# Attach reference repositories

Keep read-only clones of other projects in a library, and attach some of them to a session so the agent knows where to read them.

1. Type `/references` in the chat. The panel lists attached clones first, then the rest of the library, each with its branch.
2. Press Ctrl+N, type a git URL and press Enter. The row shows `↓ 37%` while the clone runs, then its branch. The clone goes to `~/.tau/references/<name>`, where `<name>` is the last part of the URL without `.git`.
3. Press Tab to mark the row under the cursor and move down, Shift+Tab to mark it and move up, and Ctrl+A to mark every row the filter shows (or unmark them when all are marked). Marked rows show `[x]`, and the title counts them. Type letters to filter; marks stay when the filter changes. Press Enter to attach exactly the marked clones to this session, which detaches the unmarked ones. Press Escape to close the panel and discard your marking. A clone that is still cloning cannot be marked.
4. Press Ctrl+R on a row to list its branches and switch to one.
5. Press Ctrl+U to update every clone (`git pull --ff-only`). The panel stays usable while it runs.
6. Press Ctrl+O to open a clone in `$VISUAL`, then `$EDITOR`, then `code`. Use an editor that opens its own window.
7. Press Ctrl+X on a row and answer `y` to delete the clone from disk.

To reuse clones from an older Tau, run `mv ~/.local/share/tau-agent/references ~/.tau/references`.

## What happens

Each row shows the name, the branch and, in muted text, a one-line description cut to fit the row. For a github.com clone it is the repository's GitHub description, fetched once when the clone finishes (or, for an older clone, the first time you open `/references`) and saved in the clone's `.git/tau-description`. For any other clone, or when GitHub has none, it is the first line of prose in the README.

The sidebar has a References section that lists the attached names, or "None attached".

The agent learns the references folder and the attached names from an instruction. If you attach before the first message, it is in the system prompt. If you attach later, the agent gets one labeled reminder that repeats the folder and the read-only rule, and a compaction keeps it. A clone you delete outside Tau drops out of the list.

The attached list belongs to the session. Before the first prompt, choices stay in memory and create no saved session. The first prompt saves them with the session. A restart preserves draft choices; closing an unused chat discards them. A fork keeps saved choices.

## Limits

- The agent reads the clones with its normal file and shell access. Tau does not stop it from changing them.
- A clone follows one branch (`--single-branch`). Switching to a remote branch fetches it first.
- A clone with no output for 3 minutes is stopped and removed.
- A second clone with the same name fails.
