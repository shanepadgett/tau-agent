# Markdown in the chat

Status: built 2026-10-14 (mockup approved, every recommendation accepted). Part of the daily-driver set ([daily-driver.md](daily-driver.md)). Studied: OpenCode at `5b7bad23b9` (OpenTUI 0.5.17); Tau uses OpenTUI 0.6.1, whose `MarkdownOptions` has the same props.

**What the user gets:** answers look like Markdown, not like text with the marks removed. Headings are bold, `code` has its own color, links are underlined, quotes are italic, tables have borders, and code blocks in more languages than JavaScript, TypeScript and Zig are colored.

## What exists

`Chat.tsx` draws each answer with `<markdown syntaxStyle content streaming>`. The syntax style comes from `SyntaxStyle.fromStyles` with four code scopes only.

| Piece | Today | Effect on screen |
| --- | --- | --- |
| Markdown scopes | none: OpenTUI styles text by `markup.heading`, `markup.strong`, `markup.italic`, `markup.raw`, `markup.link`, `markup.quote`, `markup.list`, `markup.strikethrough` | `conceal` is on by default, so the marks are hidden and nothing replaces them: headings, bold and inline code look like body text |
| Code scopes | `keyword`, `string`, `function`, `default` | Numbers, types, comments, operators and properties are plain |
| Languages | OpenTUI's own parsers: JavaScript, TypeScript, TSX, Markdown, Zig | Python, Go, Rust, shell, JSON and the rest are plain |
| Colors | Hex strings in six `.tsx` files (`Chat.tsx` alone has ten) | No one place to change the look |

## How OpenCode does it

| Piece | OpenCode | File |
| --- | --- | --- |
| Style | One theme turned into `SyntaxStyle.fromTheme(rules)`: about 45 rules, code scopes and every `markup.*` scope (heading bold, heading 1 also underlined, raw inline with a background, links underlined) | `packages/theme/src/tui/syntax.ts` |
| Props | `conceal`, `streaming` until the message completes, `internalBlockMode="top-level"`, `tableOptions={{ style: "grid", cellPaddingX: 1 }}`, `fg`, `bg`, `renderNode` from plugins | `packages/tui/src/routes/session/message-parts.tsx` |
| Languages | `addDefaultParsers(parsers)` once at load: 35 languages, each a `.wasm` URL and highlight query URLs; OpenTUI downloads them on first use and caches them | `packages/tui/src/parsers-config.ts` |
| Raw view | Setting `session.markdown`: `"rendered"` turns `conceal` on, anything else shows the marks | `routes/session/index.tsx` |
| Style lifetime | A new style when the theme changes; the old one is destroyed once the renderer is idle | `context/theme.tsx`, `createSyntaxStyleMemo` |

## Mockup (approved 2026-10-14)

The same answer, today and after. Colors are named on the right.

```
Today                                     After
──────────────────────────────────────    ──────────────────────────────────────
Why the test fails                        Why the test fails            bold, blue
                                          
The runner calls runNext before the       The runner calls runNext before the
handle holds the fiber. See               handle holds the fiber. See
runner.ts.                                runner.ts.        runNext, runner.ts: green
                                          
| Case  | Result |                        ┌───────┬────────┐
| ----- | ------ |                        │ Case  │ Result │
| empty | passes |                        ├───────┼────────┤
                                          │ empty │ passes │
                                          └───────┴────────┘
def run(prompt):                          def run(prompt):     def: purple, run: blue
    return queue.take()                       return queue.take()   (now colored)
```

## Shape

| Step | Change | Reuses |
| --- | --- | --- |
| Prep | New `src/tui/internal/theme.ts`: the palette, one name per color, and the syntax rules as `ThemeTokenStyle[]`. Every `.tsx` file takes its colors from it | `SyntaxStyle.fromTheme(rules, renderer.nativeScene)` from `@opentui/core` |
| 1 | Rules for every `markup.*` scope and the common code scopes, adapted from OpenCode's list | OpenCode's scope list as a guide; Tau writes its own |
| 2 | `<markdown>` gets `fg`, `tableOptions={{ style: "grid", cellPaddingX: 1 }}` and `internalBlockMode="top-level"` | OpenTUI props |
| 3 | More languages through `addDefaultParsers`, cached in OpenTUI's default data folder | OpenTUI's tree-sitter client |
| Later | `renderNode` becomes an extension place in step 7; a raw view waits until someone asks | — |

`App` makes the syntax style once and passes it down; today `Chat` makes one on each mount and never destroys it.

## Decisions (agreed 2026-10-14)

| # | Decision | Agreed |
| --- | --- | --- |
| 1 | Approve the mockup? | — |
| 2 | Extra languages: download on first use (OpenCode), ship them in the binary, or JavaScript and TypeScript only for now | Download on first use, for the languages you use most (Python, Go, Rust, shell, JSON, YAML, CSS, HTML, TOML, diff); offline, a block stays plain. Shipping all of them grows the binary by several MB |
| 3 | `internalBlockMode="top-level"` is marked "internal only" in OpenTUI's types | Use it, as OpenCode does: each top-level block renders on its own, so streaming redraws only the last block. Risk: it can change in an OpenTUI update |
| 4 | Colors: one fixed palette now, themes later | Yes. Themes are package contents in step 8 ([sdk-catalog.md](../sdk-catalog.md)) |

## Tests

`tests/tui/chat.test.ts` gets one answer with a heading, inline code, a table and a Python block. It checks `captureCharFrame` for the table borders and no `#` or backticks, and `captureSpans` for bold on the heading.
