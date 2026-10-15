# Questions

Open questions for the user. Each is removed as soon as it is answered.

Notifications ([work/notifications.md](work/notifications.md)):

1. Must custom audio also work when Tau runs remotely over SSH? Terminal banners and host-local audio have different remote behavior.

## Session persistence exit output

Approve the code plan and exit-output mockup in chat: quitting an unused draft prints no `Session: <id>` line; saved sessions keep their resumable ID output. See [work/session-persistence.md](work/session-persistence.md).

## Multi-select picker

What is the first use, and should Escape cancel or apply the marks so far? (Recommended: cancel.)

## Stash and pop

Plan: [work/stash.md](work/stash.md).

1. Which key stashes? Alt+S is on `main`, but Alt often needs terminal setup on macOS. Ctrl+S is XOFF in some terminals. (Recommended: Alt+S, unless you know it fails for you.)
2. Should the stash key hint show only while the input has text, and should the quit hint come back when the input is empty? (Recommended: yes to both.)
3. One stash list for all projects (as on `main`) or one per project? (Recommended: all projects.)
4. Should stashing an empty input pop the latest stash, so one key does both, with `/pop` for browsing? (Recommended: no, keep the keys single-purpose.)
