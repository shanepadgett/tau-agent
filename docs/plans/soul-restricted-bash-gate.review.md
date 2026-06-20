# Review: soul restricted-posture bash gate

Branch: main. Files: `src/extensions/soul/{index.ts,postures.ts,README.md}`.

Shape: replaces hard tool-hiding on posture switch (strip bash/edit/write from
restricted postures, save/restore `previousTools`) with a single call-time gate.
Read-only bash now allowed in plan/review/debug; mutating bash + write/edit
outside `docs/plans/` prompt a switch-to-act confirm. Deletes
`RESTRICTED_TOOLS`/`ACT_TOOLS`/`previousTools`/`fromRestore` + 3 helpers. Net
~30 lines. Direction is right: simpler, and read-only bash in restricted
postures is genuinely useful. Gate strength dropped from exact (tool absent) to
a denylist for bash, though — and the denylist has holes on both sides.

## Findings

src/extensions/soul/postures.ts:39: bug false-positive on fd redirects. `/(^|[^>])>\s*(?![&12])/` matches `2>/dev/null`, `1>file`, `2>file`: the fd digit is eaten by `[^>]` and the lookahead only checks after `>`, so it never exempts `N>/file`. Tripped live in this review — two benign `rg ... 2>/dev/null` evidence checks got flagged as mutating. Smallest fix: lookbehind to drop fd-prefixed redirects, e.g. `/(?<![0-9&>])>\s*(?![&12])/`. Keeps `>file`/`>>file` caught, still allows `>&1`/`>&2`, exempts `1>`/`2>`/`&>`.

src/extensions/soul/postures.ts:35: gap mutating in-place editors defeat the edit gate. `sed -i`, `perl -i`, `awk -i inplace` edit files via bash and are not in the denylist — a restricted posture can mutate source with no prompt, bypassing the write/edit path check entirely. That's the one class that actually matters, since it undercuts the write/edit gate the change keeps. Smallest fix: add `/(^|[;&|]\s*)(sed|perl)\b[^\n]*\s-i\b/` and `awk\b.*-i\s+inplace/`.

src/extensions/soul/postures.ts:35: gap other git/fs mutators slip through: `git apply|cherry-pick|revert|tag|branch -D|init|clone`, `dd of=`, `truncate -s`, `curl … | sh`. Lower stakes (advisory gate, model is prompt-bound), but the README oversells it as "clearly mutating bash commands require act posture". Smallest fix: extend the git alternation (`apply|cherry-pick|revert|tag|branch`) and add `dd\b.*\bof=`; or soften README/posture wording to "best-effort mutating-bash detection".

src/extensions/soul/postures.ts:39: nit bare-`>` also false-positives on quoted/bracketed contexts: `grep -F '>' f`, `[[ a > b ]]`, `$((a > b))`. The lookbehind fix above doesn't help these. Rare in agent bash; accept for an advisory gate, noted for the record.

src/extensions/soul/postures.ts:~258: dead defensive guard. `confirmActSwitchForRestrictedTool`'s `if (!activePosture) return undefined;` is unreachable — both callers only reach it after `RESTRICTED_POSTURES.has(activePosture)`. Harmless; delete if touching the function anyway.

README.md:41 / postures guidance: consistency the debug/plan/review blocks say "No … mutating commands" absolutely, but the gate permits them via switch-to-act (same pattern as the write/edit lines). Wording is consistent with the existing style, so not a blocker — but pair whatever absolute phrasing you keep with the README's "clearly mutating" caveat so the softness is in one place.

## Non-findings (checked, fine)

- No dangling refs: `RESTRICTED_TOOLS`/`ACT_TOOLS`/`previousTools`/`isRestrictedPosture`/`filterKnownTools`/`ensureTools` fully removed, no other uses in `postures.ts` or `index.ts`.
- `DEFAULT_TOOLS` (index.ts) is prompt-display-only (`formatToolList` filters by snippet); adding grep/find/ls is cosmetic + lets them appear in the tool list. Not a gating change.
- `tool_call` handler control flow correct: non-mutating bash and read/grep/find/ls/switch_posture short-circuit to allow; bash mutating + write/edit-outside-plans route through the shared confirm; `isEnabled()` checked first. `switch_posture` stays available in restricted postures (the escape hatch) — right.
- Trade-off (hard hide → soft denylist) acceptable *if* the two real gaps above are closed; the edit-gate bypass via `sed -i` is the only one that undermines a guarantee the change claims to keep.

## Verdict

Don't ship as-is. The redirect false-positive is a live regression (broke this
review) and `sed -i`/`perl -i` punch a hole in the write/edit gate the change
preserves. Both are small regex fixes. After those + a README tone tweak, lean.
