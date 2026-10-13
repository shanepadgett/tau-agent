# Footer Extension

Replaces Pi’s default footer with a two-row footer below the editor. The context bar appears in the center of the editor’s top border.

## Commands

```text
/footer
/footer on
/footer off
/footer refresh
```

## Layout

The context bar appears in the editor’s top border:

```text
── work order 4521 ─────────────── [••••·--?---!-|------] ───────────────
 > type here
──────────────────────────────────────────────────────────────────────────
```

Two-row footer below the editor:

```text
Opus (high) · Jev                                  CH98% · $0.18 session · $2.43 today
~/dev/open-source/tau-agent · main (+2 ~1)          reviewing bash · Session name
```

No polling. Git and daily cost refresh on lifecycle events or `/footer refresh`.

The first footer row shows the model name without a leading “Claude ”, the thinking level in parentheses, and the decision classifier (`Jev` or `Luna`) at left. Cache-hit rate, session cost, and daily cost appear at right; costs include decision calls. Cost labels are omitted when the labeled form does not fit. The second row shows the working directory and Git branch/change counts at left, with extension statuses and the session name at right.

The context bar shows cached (`•`), used (`·`), and free (`-`) context. After compaction, it estimates usage from the active transcript until Pi reports fresh context usage. With self-compaction on, `?` and `!` mark the notice and warning thresholds; a short tail tracks usage from forced compaction to the model’s context limit. Without self-compaction, the bar spans the context window. Colors indicate usage and compaction state.

`/footer off` hides both footer rows and the context bar. Statuses set with Pi’s `setStatus` appear in the first row at the right.
