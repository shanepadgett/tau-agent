# Future: absorb Ponytail audit/debt behavior

## Goal

Add Tau-native equivalents for Ponytail's repo-wide audit and shortcut-debt ledger so the Ponytail extension can be uninstalled without losing those workflows.

Do **not** remove, uninstall, edit, or depend on the installed Ponytail extension. Reference only.

Reference repo, read-only:

`/Users/shanepadgett/.local/share/tau-agent/references/ponytail`

Relevant files already inspected:

- `skills/ponytail-audit/SKILL.md`
- `skills/ponytail-debt/SKILL.md`
- `.opencode/command/ponytail-audit.md`
- `.opencode/command/ponytail-debt.md`
- `skills/ponytail-review/SKILL.md` as audit's base behavior
- `skills/ponytail/SKILL.md` for `ponytail:` marker convention
- `README.md` command table

## Ponytail audit behavior to preserve

Ponytail audit is repo-wide Ponytail review.

It scans the whole tree, not just the current diff, and reports over-engineering only. It does not apply fixes.

Core prompt from reference:

> Audit the entire repository for over-engineering only, not correctness. Scan the whole tree, not a diff. One line per finding, ranked biggest cut first: `<tag> <what to cut>. <replacement>. [path]`. Tags: delete, stdlib, native, yagni, shrink. End with the net lines and dependencies removable. If nothing to cut: `Lean already. Ship.`

Reference tags:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

Reference hunt list:

- dependencies that stdlib/platform already covers
- single-implementation interfaces
- factories with one product
- wrappers that only delegate
- files exporting one thing
- dead flags and config
- hand-rolled stdlib
- unused flexibility
- speculative features

Reference output:

`<tag> <what to cut>. <replacement>. [path]`

Rank biggest cut first.

End:

`net: -<N> lines, -<M> deps possible.`

If clean:

`Lean already. Ship.`

Boundaries:

- complexity only
- correctness bugs, security holes, and performance go to normal review unless caused by avoidable complexity
- report only; apply nothing
- one-shot command/mode, not persistent posture unless we choose otherwise

## Tau audit adaptation

Tau review is intentionally broader than original Ponytail review. Tau audit should be the repo-wide version of Tau review, not only the original five Ponytail tags.

Tau audit tags should include:

- `delete:` dead code, stale config, speculative feature, unused flexibility
- `shrink:` same behavior, fewer moving parts
- `dedupe:` repeated logic that should share one implementation
- `stdlib:` hand-rolled standard-library behavior
- `native:` platform/runtime feature beats custom code or dependency
- `internal:` repo already has utility/pattern/tool for this
- `yagni:` abstraction/config/layer/interface/factory that does not earn its keep
- `refactor:` small structure change that reduces bug surface or clarifies invariant

Tau audit should still rank findings biggest simplification/stability win first.

Suggested Tau output:

`<tag> <problem>. <smallest fix>. [path]`

Optional end metric:

`net: -N lines possible, -M deps, -K duplicated paths.`

Do not fake metrics. If line/dependency estimate is weak, omit it.

## Ponytail debt behavior to preserve

Ponytail debt harvests every deliberate shortcut marker into a ledger so deferrals do not silently become permanent.

Core prompt from reference:

> Every deliberate ponytail shortcut is marked with a `ponytail:` comment naming its ceiling and upgrade path. This collects them into one ledger so a deferral can't quietly become permanent.

Reference scan command:

`grep -rnE '(#|//) ?ponytail:' .`

with skips:

- `node_modules`
- `.git`
- build output

Reference says to add other comment prefixes if stack uses them.

Reference row format:

`<file>:<line> — <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

Reference convention:

`ponytail: <ceiling>, <upgrade path>`

Important behavior:

- each marker becomes one ledger row
- grouped by file
- comment prefix keeps prose mentions out of ledger
- optional owner can be added with `git blame -L<line>,<line>` if wanted
- markers with no upgrade path/trigger get `no-trigger`
- those are rot risk

Reference ending:

`<N> markers, <M> with no trigger.`

If none:

`No ponytail: debt. Clean ledger.`

Boundaries:

- reads and reports only
- changes nothing
- if user asks to persist, write ledger to a file such as `PONYTAIL-DEBT.md`
- one-shot command/mode

## Tau debt adaptation

Tau currently tells Lyle to use `lean:` comments, not `ponytail:` comments:

`// lean: linear scan OK under 500 items; upgrade to id index if hot`

Project convention from soul:

- use `lean:` comments only for deliberate simplifications with a known ceiling
- comment must name what is simplified
- comment must say when it stops being OK
- comment must name upgrade path
- do not mark bugs, TODOs, vague concerns, or ordinary obvious code

Tau debt should scan for `lean:` first.

Question for implementation: also scan legacy `ponytail:` markers?

Recommended: yes, at least initially. We already converted known repo markers to `lean:`, but external/user repos may contain `ponytail:` from old behavior. Debt command can report both and maybe tag marker type.

Suggested scan patterns:

- line comments: `// lean:`, `# lean:`
- block/doc comments if common in target stack: `/* lean:`, `* lean:`
- legacy: same prefixes with `ponytail:`

Suggested skip dirs:

- `.git`
- `node_modules`
- `dist`
- `build`
- `coverage`
- `.next`
- `.turbo`
- `.pi/cache`
- `.pi/tmp`
- `.pi/temp`
- `.pi/sessions`
- generated/vendor/reference dirs as appropriate

Suggested Tau row:

`<file>:<line> — <marker> <summary>. ceiling: <limit>. upgrade: <trigger/path>.`

Tags:

- `no-trigger` when no clear revisit condition/upgrade trigger exists
- `legacy` for `ponytail:` markers if we support them
- `weak` when marker is vague, e.g. “for now”, “later”, “temporary” without concrete limit

End:

`<N> markers, <M> no-trigger, <L> legacy.`

If none:

`No lean debt. Clean ledger.`

If user asks to persist:

- write a short markdown ledger, probably `LEAN-DEBT.md`
- do not overwrite existing ledger without reading it first
- group by file
- include generated timestamp only if repo docs already tolerate noisy generated dates; otherwise avoid churn

## Command shape

Add slash commands only if command plumbing stays small:

- `/audit` — repo-wide complexity/stability audit
- `/debt` — scan shortcut markers and report ledger

Both should support trailing text if useful:

- `/audit src/extensions`
- `/audit focus command parsing`
- `/debt`
- `/debt include legacy ponytail markers`

Preferred behavior:

- one-shot command, not persistent mode
- send hidden prompt with `pi.sendMessage(..., { triggerTurn: true })`, like `/qna` and `/interview`
- do not change active mode unless implementation proves simpler to reuse review mode

If we do switch mode:

- `/audit` should probably switch to review posture for that turn only, not permanently
- avoid adding persistent `audit` mode unless user asks

## Implementation sketch

1. Inspect current command registration in `src/extensions/soul/postures.ts` and existing `pi.sendMessage` examples in `src/extensions/qna/index.ts`.

2. Decide placement.
   - Smallest likely path: keep `/audit` and `/debt` commands in `postures.ts` near review/debug shortcuts.
   - If file gets crowded, extract later. Do not pre-split.

3. Implement `/audit` as hidden prompt text.
   - Prompt says repo-wide review, ranked biggest simplification first.
   - Include Tau tags, output format, clean response.
   - Mention report-only unless user explicitly asks edits.
   - Include optional user args as focus/scope.

4. Implement `/debt` as hidden prompt text.
   - Prompt says scan for `lean:` and legacy `ponytail:` markers.
   - Include skip dirs.
   - Include row format and no-trigger behavior.
   - Reads/reports only unless user asks to persist.

5. Add tiny parser helpers only if needed.
   - Existing `commandPrompt(args)` can trim trailing text.
   - No new parser framework.

6. Run `mise run check`.

## Prompt drafts

### `/audit`

```txt
Run a repo-wide complexity/stability audit. Report only unless user explicitly asks for edits.

Scan the whole relevant tree, not just the diff. Rank biggest simplification/stability wins first.

Tags: delete, shrink, dedupe, stdlib, native, internal, yagni, refactor.

Hunt: dead code, stale config, speculative features, unused flexibility, duplicated logic, single-implementation interfaces, factories with one product, delegate-only wrappers, files/layers that do not earn their keep, hand-rolled stdlib, dependencies/platform code replacing native behavior, internal utilities not reused.

Format: <tag> <problem>. <smallest fix>. [path]

Mention correctness/security/perf only when complexity causes the risk.

End with net removable lines/deps/duplicated paths only if you can estimate honestly. If clean: Lean already. Ship.
```

### `/debt`

```txt
Harvest lean shortcut markers into a debt ledger. Report only unless user asks to persist.

Scan for comment markers: lean: and legacy ponytail:. Include line-comment prefixes (#, //) and block/doc comment prefixes if present in this stack.

Skip .git, node_modules, dist, build, coverage, generated output, and agent cache/session/temp dirs.

One row per marker, grouped by file:
<file>:<line> — <marker> <what was simplified>. ceiling: <limit>. upgrade: <trigger/path>.

Tag no-trigger when the marker lacks a concrete revisit trigger or upgrade path. Tag legacy for ponytail: markers. Tag weak when the marker is vague.

End with: <N> markers, <M> no-trigger, <L> legacy.

If none: No lean debt. Clean ledger.
```

## Open decisions

- Should `/audit` be one-shot only or temporarily reuse review mode for the turn?
- Should `/debt` scan both `lean:` and `ponytail:` forever, or only during transition?
- Persisted ledger filename: `LEAN-DEBT.md`, `TAU-DEBT.md`, or user-chosen?
- Should debt include `git blame` owner info when available, or only when requested?

