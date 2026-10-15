# The sidebar

Status: being considered, 2026-10-14. Nothing agreed yet; open questions are in [questions.md](../questions.md). A mockup comes before any build.

**What the user gets:** a panel on the right of the chat with session state (context use, cost, running process sessions, compaction), opened and closed with one key. This is slice 6b in [tui.md](tui.md).

## Today

```text
App.tsx (src/tui/internal)
  place "app"            one column, full width
    place "chat"         transcript, grows
    input block          run panel, status strip, editor, footer
```

- No sidebar is built. [sdk-catalog.md](../sdk-catalog.md#named-ui-places) names the places `sidebar.left` (empty by default, takes no space) and `sidebar.right` (Tau's panels), and says "below a width set in settings, sidebars hide and a key toggles them".
- Keys live in `keyAction` in `App.tsx`: Escape, Ctrl-C, Ctrl-D. There is no leader key and no key settings yet.

## Can OpenTUI animate it?

Yes. OpenTUI 0.6.1 has `Timeline` (`createTimeline` in `@opentui/core`, `useTimeline` in `@opentui/solid`). It tweens numeric properties over a duration with named easings (`outQuad`, `outExpo`, `inOutSine`, `outCirc` and others; no custom curves, no springs). The renderer draws every frame while a timeline plays and goes idle after. Source: `docs/reference/copies/@opentui/core/0.6.1/.../application-apis/animation.mdx`.

Limits that shape the design:

| Limit | Effect |
| --- | --- |
| Movement is in whole cells | A 40-column panel slides in at most 40 steps; at 150–200 ms that still reads as smooth |
| Only top-level numeric properties | Animate `width` or `translateX` (both numbers on a renderable), not colors |
| Animating `width` re-lays-out the chat each frame | Long Markdown transcripts re-wrap every frame; may stutter |
| Animating `translateX` moves pixels only | No layout work, but the panel then floats over the chat |

OpenCode (`packages/tui/src/component/session-frame.tsx`) does not animate: the sidebar snaps in. On terminals wider than 120 columns it pushes the chat aside; narrower, it floats over a dimmed chat. Its toggle is `<leader>b` (leader is Ctrl-X).

## Docked or drawer: picked by width, live (agreed 2026-10-14)

The sidebar is **docked** (a column beside the chat that narrows it) when the chat would keep enough room, and a **drawer** (floats over the chat from the right edge) when it would not. The choice is re-made on every terminal resize, both ways: narrowing turns a docked panel into a drawer, widening turns a drawer back into a docked panel.

```text
mode = terminal width − sidebar width ≥ minimum chat width ? docked : drawer
```

- Width comes from `useTerminalDimensions()` in `@opentui/solid`, a signal that updates on resize; `mode` is a Solid memo over it.
- The rule reads only the terminal width, never the laid-out chat, so docking cannot change its own input and the mode cannot flicker.
- A mode change during a resize snaps; only the key toggle animates.

```text
docked, wide                         drawer, narrow
┌──────────────────────┬─────────┐   ┌──────────────────┬─────────┐
│ chat                 │ sidebar │   │ chat (dimmed)    │ sidebar │
│                      │         │   │          under → │ on top  │
├──────────────────────┤         │   ├──────────────────┴─────────┤
│ input                │         │   │ input                      │
└──────────────────────┴─────────┘   └────────────────────────────┘
```

Shape sketch only; the real mockup comes before the build.

## Animation choices

| Mode | Toggle animates | Cost |
| --- | --- | --- |
| Drawer | `translateX` slide | Cheap: no layout work per frame |
| Docked | `width` grows, or snap | Chat re-wraps every frame; test with a long transcript before choosing |
