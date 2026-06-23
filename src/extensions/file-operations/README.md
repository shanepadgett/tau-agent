# File Operations

Token-efficient file tools for Tau.

This extension replaces `read` with a Pi-compatible reader that returns line-addressed file chunks for the agent while keeping the user-facing tool output compact.

Use it like Pi's built-in read:

```ts
read({ path: "src/foo.ts" })
read({ path: "src/foo.ts", offset: 35, limit: 20 })
```

It also supports multiple ranges:

```ts
read({
  path: "src/foo.ts",
  ranges: [
    { offset: 35, limit: 20 },
    { offset: 120, limit: 12 }
  ]
})
```

Collapsed output shows only the tool call. Expanded output shows numbered file content.
