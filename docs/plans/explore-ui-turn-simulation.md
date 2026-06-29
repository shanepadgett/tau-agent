# Explore UI Turn Simulation

Purpose: rough conversation/UI storyboard for discussing outcomes. Not implementation truth.

Legend:

- `[active]`: normal visible tool call/result.
- `[prune-candidate]`: later evidence probably supersedes this, but it may remain for cache economics.
- `[pruned]`: result body removed from model context; TUI command line should show yellow/stale state.
- `[kept]`: still useful evidence/current context.
- `[changed]`: file was mutated after this evidence.

## Turn A: basic exploration, then current read

User asks: “Find where config is loaded.”

```text
assistant: I’ll inspect config loading paths.

tool grep [active]
  call: grep /loadTauExtensionSettings/ in src
  collapsed result: grouped hits, compact paths/lines
  expanded result: all shown hits and omissions

assistant: Reads likely target.

tool read [active]
  call: read src/extensions/search/index.ts
  collapsed result: hidden or small preview, depending approved UI
  expanded result: full file text

end of turn pruning review:
  grep stays [kept] if it still explains navigation.
  read stays [kept] as current file context.
```

## Turn B: whole-file reread supersedes older whole-file read

User asks follow-up: “Now change that behavior.”

```text
assistant: Reads file again before patching.

tool read [active]
  call: read src/extensions/search/index.ts
  result: full current file

tool patch [active]
  call: patch src/extensions/search/index.ts
  result: M src/extensions/search/index.ts

tool read [active]
  call: read src/extensions/search/index.ts
  result: full current file after patch

end of turn pruning review:
  earlier same-file whole read => [prune-candidate]
  post-patch whole read => [kept]
  patch result => [kept]
  actual pruning waits for economic decision.
```

If pruned later:

```text
tool read [pruned/yellow]
  call: read src/extensions/search/index.ts
  result body in model context: [pruned]
```

## Turn C: range reads that do not supersede each other

Agent works in huge file.

```text
tool read [active]
  call: read src/big.ts:100-140
  result: function A

tool read [active]
  call: read src/big.ts:900-940
  result: function B

end of turn pruning review:
  both reads stay [kept]
  ranges do not overlap and neither supersedes the other.
```

## Turn D: range reread supersedes overlapping older range

```text
tool read [active]
  call: read src/big.ts:100-140
  result: function A old view

tool patch [active]
  call: patch src/big.ts
  result: M src/big.ts

tool read [active]
  call: read src/big.ts:95-155
  result: function A wider current view

end of turn pruning review:
  read 100-140 => [prune-candidate]
  read 95-155 => [kept]
```

## Turn E: grep becomes stale after mutation

```text
tool grep [active]
  call: grep /oldName/ in src
  result: src/a.ts, src/b.ts hits

tool patch [active]
  call: patch src/a.ts
  result: M src/a.ts

end of turn pruning review:
  grep evidence mentioning src/a.ts => [changed]
  maybe [prune-candidate], maybe just yellow stale marker
  economic decision decides whether to remove result body from model context.
```

## Turn F: tau-edit without required auto-read correctness

```text
/tau-edit selects files:
  src/extensions/foo/index.ts
  src/extensions/foo/settings.ts

tau-edit prompt includes:
  Selected files:
  - src/extensions/foo/index.ts
  - src/extensions/foo/settings.ts

optional event listener may inject current file snapshots.

if no listener or auto-read disabled:
  agent still knows exact paths to read.
```

Outcome: auto-read becomes convenience, not correctness dependency.

## UI approval surfaces to design

For each conversation-visible thing:

- Initial call while args may still be streaming/incomplete.
- Active call before result.
- Collapsed successful result.
- Expanded successful result.
- Error result.
- Prune-candidate/stale visual state.
- Pruned visual state.

Current candidate rule: pruned/stale tool command line uses yellow/warning styling.
