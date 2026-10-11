# Footer Extension

Replaces Pi’s default footer with Tau’s three-row footer.

## Commands

```text
/footer
/footer on
/footer off
/footer refresh
```

## Layout

```text
auto:route • provider/model (thinking) • provider/classifier     [••••·--?---!-|------] • CH98% • S|$0.18 D|$2.43
cwd • session                                        other extension statuses
git branch (changes)                                 footer items
```

Other Tau extensions can publish bottom-right items with `setTauFooterItem()` from `shared/events.ts (or public event bus docs)`.

No polling. Git and daily cost refresh on lifecycle events or `/footer refresh`.

Automatic routing adds `auto:<route>` before the current model. The classifier appears beside it as `provider/model` when available. The context bar precedes cache-hit rate, with session and daily costs at the far right. Costs include decision calls.

The context bar shows cached, used, and free space. With self-compaction on, the bar spans up to the forced compaction threshold, with `?` and `!` marking the notice and warning thresholds. A short tail after it fills as usage passes forced compaction toward the model's context limit. Without self-compaction, the bar spans the whole context window. Colored dots show usage progressing from green to yellow to red. A NOTICE, WARNING, or FORCED tag identifies the current level. Self-compaction progress appears above the editor.
