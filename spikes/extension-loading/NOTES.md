# Extension loading

**Question:** in a compiled `tau` binary, can a user's `.ts` extension import `@shanepadgett/tau` and get the binary's own copy, and can edited extensions reload without a restart?

**Answer: yes to both.** Bun 1.4.3.

## Setup

`host.ts` is compiled with `bun build --compile host.ts --outfile dist/tau`. At startup it registers a runtime plugin that serves `@shanepadgett/tau` as a virtual module from the embedded `sdk.ts`:

```ts
plugin({
 name: "tau-sdk",
 setup(build) {
  build.module("@shanepadgett/tau", () => ({ exports: { ...sdk }, loader: "object" }));
 },
});
```

It then writes an extension to a temp dir outside the binary (`index.ts` importing the SDK, a relative `helper.ts`, and a package from the extension's own `node_modules`), loads it, edits both `.ts` files, and loads again. The extension dir also contains a shadow `node_modules/@shanepadgett/tau` that throws if used, as an author's devDependency would.

Run: `bun run host.ts [strategy]` or `./dist/tau [strategy]`.

## Results

Same in `bun run` and the compiled binary, including from `/` with only `/usr/bin:/bin` on PATH (no Bun installed needed).

| Strategy | Entry reloads | Helper reloads | Load time |
| --- | --- | --- | --- |
| `plain` re-import | no (cached, nothing re-registers) | no | ~1–3 ms |
| `?v=n` query on entry | yes | **no** (stale helper) | <1 ms |
| delete `require.cache` keys under the extension dir, then import | yes | yes | <1 ms |
| `Bun.build` the extension with the SDK external, import the bundle | yes | yes | 3–4 ms first, <1 ms after |

In every strategy:

- `.ts` files outside the binary are transpiled and run by the binary itself.
- The plugin's SDK wins over the extension's local `node_modules/@shanepadgett/tau`. The extension sees the same SDK instance as the host (`sameSdk=true`), so module state is shared.
- Packages in the extension's own `node_modules` resolve normally.

## Takeaways

- Use the runtime plugin for the SDK. No tsconfig or install tricks are needed at runtime.
- For `/reload`, deleting `require.cache` entries under extension dirs is the simplest working option; it works for ESM too. `Bun.build` bundling is the fallback if cache deletion turns out to leak or miss files; it also gives a fresh module graph per reload.
- Query-string cache busting is not enough on its own: it reloads only the entry file.
- Compiled binary size: 68 MB.

## Not tested

- Memory growth over many reloads with `require.cache` deletion.
- Error messages for a syntax or runtime error inside an extension.
- Extensions that keep timers or listeners alive across a reload (a lifecycle concern for the host, not the loader).
