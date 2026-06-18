# Footer Extension

Replaces Pi’s default footer with Tau’s compact two-line footer.

## Commands

```text
/footer
/footer on
/footer off
/footer refresh
```

## Layout

```text
git • model • thinking                         S $0.18 · D $2.43
cwd • session                                  footer items
```

Other Tau extensions can publish bottom-right items with `setTauFooterItem()` from `src/shared/events.ts`.

No polling. Git and daily cost refresh on lifecycle events or `/footer refresh`.
