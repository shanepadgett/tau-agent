# Working Memory

Working Memory keeps outbound model context smaller by replacing old tool evidence with tiny stubs while leaving raw session history intact.

Use `forget` when exploration produced large reads or grep output and the remaining facts fit in a short checkpoint. If a read file is irrelevant and automatic stubbing will not remove it, forget it and put the discard reason in `keep` once. Old outputs stay as tiny stubs.

Automatic stubbing is deterministic and branch-local:

- broad reads become `[superseded]` after narrower reads cover the needed range
- reads become `[stale]` after later file mutations touch that path
- grep output becomes `[superseded]` after every matched file is read later, when stubbing saves enough context
- patch input/results become `[superseded]` after compact per-file patch snapshots exist

Tiny grep results may stay visible because replacing them would not save enough context.

Reload Tau after changing extension code before testing it.
