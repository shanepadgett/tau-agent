# Anti-slop lint rules and reference docs

This repo has 41 hand-written oxlint rules. Most of them block patterns that AI coding agents tend to produce. The repo also keeps a copy of each dependency's docs in `docs/reference/`, pinned to the versions in the lock file (`deno.lock`, which records exact dependency versions). Agents read those copies, so they use the docs for the version in use.

Paths below are from this repo. The pseudocode shows the mechanism so another project can rebuild it.

## Lint rules

### How the pieces fit

```text
.oxlintrc.json
  jsPlugins: ["./tools/lint/plugin.ts"]      # load the plugin
  rules: "foundry/<name>": "error"           # one entry per rule
  overrides: tools/lint/** turns off most foundry rules

tools/lint/plugin.ts
  export default { meta: { name: "foundry" }, rules: { "<name>": rule, ... } }

tools/lint/rules/<name>.ts                   # one rule per file
  /** Why: what goes wrong, and what to write instead. */
  export const rule = {
    meta: { messages: { <id>: "message" }, fixable: "code" },   # fixable only if it autofixes
    create(context) {
      return {
        <AstNodeType>(node) {                # runs for each matching node
          if (<bad pattern>) context.report({ node, messageId: "<id>", fix });
        },
      };
    },
  };

tools/lint/rules/<name>.test.ts              # one test file per rule
  tester.run("foundry/<name>", rule, {
    valid:   [{ name: "clean case", code: "..." }],
    invalid: [{ name: "bad case", code: "...", output: "autofixed code" }],
  });                                        # use errors: [{ messageId }] when there is no autofix
```

### Commands

| Task       | Command                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Lint       | `node_modules/.bin/oxlint --format=agent`. Add `--fix` to apply autofixes.                                                         |
| Rule tests | `node --test "tools/lint/**/*.test.ts"`. `RuleTester` runs under `node:test`.                                                      |
| All checks | `mise run check`. It runs format, lint, types, dead code, duplication, rule tests, structure, reference docs, and Markdown checks. |

### Anti-slop rules (35)

Each rule file opens with a doc comment that gives the reason. These 35 comments name AI agents as the cause of the mistake. All names are prefixed `foundry/`. Rules marked "autofix" can rewrite the code with `--fix`.

| Rule                             | Flags                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assertion-needs-safety-comment` | `as` casts with no `// SAFETY:` comment that says why the type is right                                                                             |
| `no-chained-assertions`          | `x as unknown as T`, which turns off type checking                                                                                                  |
| `no-known-value-widening`        | A vague type such as `unknown` or `Record<string, number>` on a value whose exact type TypeScript already knows                                     |
| `no-loose-dictionary`            | `Record<string, unknown>`. List the keys and their types instead.                                                                                   |
| `no-object-parameters`           | Parameters typed `object`                                                                                                                           |
| `no-runtime-typeof`              | `typeof` checks scattered through code. Validate once where data enters the app.                                                                    |
| `no-unknown-aliases`             | Type aliases to `unknown`                                                                                                                           |
| `no-unknown-parameters`          | Parameters typed `unknown`                                                                                                                          |
| `no-unknown-returns`             | Return types of `unknown`                                                                                                                           |
| `no-widen-then-assert`           | A known type widened to `unknown`, then cast to another type                                                                                        |
| `no-empty-object-spread`         | Conditional spreads such as `{ ...(cond ? { a } : {}) }` and `{ ...(cond && { a }) }`. Autofix.                                                     |
| `no-filter-map`                  | `.filter(...).map(...)` chains. Autofix.                                                                                                            |
| `no-reduce-copy`                 | Copying the accumulator on each `reduce` step                                                                                                       |
| `no-reflect`                     | `Reflect.get` and `Reflect.apply` used to get past type errors                                                                                      |
| `readable-spacing`               | Dense code with no blank lines between steps. Autofix adds the blank lines.                                                                         |
| `error-needs-cause`              | A new `Error` thrown in a `catch` without `{ cause: error }`                                                                                        |
| `no-boolean-parameters`          | Boolean parameters. Use an options object or a union of named values.                                                                               |
| `no-commented-code`              | Comments that parse as code. Autofix deletes them.                                                                                                  |
| `no-internal-references`         | Comments that point to repo docs, design names, or pull requests instead of stating the fact                                                        |
| `no-restating-jsdoc`             | JSDoc that repeats the name or the types. Autofix deletes a summary that only repeats the name.                                                     |
| `no-swallowed-error`             | A `catch` that returns `[]` or `null` and never reads the error                                                                                     |
| `timer-needs-named-constant`     | Inline delays such as `setTimeout(fn, 30000)`. Name the value and its unit.                                                                         |
| `island-body-lazy`               | An island's `*Body.tsx` file imported at the top instead of with `import()`                                                                         |
| `island-fetch`                   | `fetch()` inside an island. Use `getJson`, `sendJson`, or a query.                                                                                  |
| `island-props`                   | Function props passed to an island. Only data can cross.                                                                                            |
| `live-through-stream`            | Opening a private `EventSource`, or refreshing with `f-partial`, instead of `subscribe` and `refreshPartial`                                        |
| `use-hash-helpers`               | Hand-written digests or hex encoding. Use the shared helpers.                                                                                       |
| `unit-in-policy-names`           | Timeouts, TTLs, and limits with no unit in the name, such as `timeout = 30`                                                                         |
| `layer-imports`                  | Imports across a context's layers, such as a store imported into `model/`                                                                           |
| `no-server-event-handlers`       | `onClick` and other handlers on server-rendered elements                                                                                            |
| `package-boundaries`             | Imports that break the package graph: relative paths into another package, Fresh outside `apps/web`, inline `npm:` versions, server code in islands |
| `route-exports`                  | Route files that export anything except `handlers`, `default`, `config`, and `operations` under `routes/api/`                                       |
| `server-context`                 | `new Date()`, `Deno.env`, or `crypto.randomUUID()` in service code. Use injected values.                                                            |
| `store-owns-sql`                 | SQL outside the owning context's `store.ts`                                                                                                         |
| `tests-through-http`             | Integration tests that import services, stores, or `postgres` directly                                                                              |

### Other rules (6)

These rules enforce project layout and conventions. Their doc comments do not name agents.

| Rule                         | Flags                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ui-recipes`                 | Local copies of shared UI styles, such as a selected-row class or a button look                                             |
| `topic-through-builders`     | Live topic names written as strings instead of the `topic` builder                                                          |
| `region-through-declaration` | Live region partial names or refresh routes written outside `live-regions.ts`                                               |
| `navigation-through-owners`  | Islands that catch link clicks in the capture phase or write browser history                                                |
| `no-grab-bag-files`          | Files or folders named `utils`, `helpers`, `common`, or `misc`                                                              |
| `web-request-boundaries`     | In `apps/web`, imports of the composed `state.ts` outside `main.ts`, and feature code that skips its registered integration |

The config also turns on built-in oxlint rules, such as `typescript/no-explicit-any`. Those are not hand-written, so this list leaves them out.

### Related checks

- `fallow dead-code` reports unused files, exports, and dependencies. Config: `.fallowrc.jsonc`.
- `deno task check:dupes` fails on new or changed copy-paste blocks of 12 or more lines. Each reviewed exception, with its reason, is listed in `tools/check/duplication-exceptions.json`.
- `deno task check:structure` checks the layout of packages, web, tables, framework, and Pi extensions.

## Reference docs

Each dependency's docs are downloaded into `docs/reference/`. A manifest says where each set of docs comes from and which versions it matches. A check fails when the docs fall behind the lock file. A sync command downloads whatever is stale.

### Layout

```text
docs/reference/
  manifest.json          what to fetch, which versions, which commit
  <name>/                git and npm entries: copied files, such as README.md
  <name>.md              deno-doc entries: generated text
```

Names can contain `/`. The entry `std/async` writes `std/async.md`.

### Manifest

This example uses made-up names.

```json
{
  "ignore": ["npm:@types/example"],
  "entries": [
    {
      "name": "example-site",
      "packages": { "npm:example-lib": "2.1.0" },
      "source": {
        "kind": "git",
        "repo": "example-org/example-lib",
        "ref": { "tag": "v{version}" },
        "path": "docs",
        "pages": ["guide/*.md", "api/**/*.md"],
        "exclude": ["api/internal/**"]
      }
    },
    {
      "name": "example-readme",
      "packages": { "npm:other-lib": "1.4.0" },
      "source": { "kind": "npm", "files": ["README.md"] }
    },
    {
      "name": "std/example",
      "packages": { "jsr:@example/util": "0.3.0" },
      "source": { "kind": "deno-doc" }
    }
  ]
}
```

- `ignore`: lock-file packages that need no docs.
- `packages`: each `npm:` or `jsr:` package the docs cover, with its exact version. The keys match the lock file.
- `source.kind`: `git`, `npm`, or `deno-doc`. See the table below.
- `ref.tag`: `{version}` is replaced by the locked version. `ref.branch` follows a branch instead.
- `commit`: written by sync for git entries. It records the commit the copy came from.

### Source kinds

| Kind       | Fetches                                                   | Writes                                                                  |
| ---------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `git`      | A GitHub archive of a tag or branch                       | Files under `path` that match `pages` and not `exclude`, into `<name>/` |
| `npm`      | The registry's metadata for the version, then the tarball | Files that match `files`, into `<name>/`                                |
| `deno-doc` | Output of `deno doc --no-config <spec>@<version>`         | One file, `<name>.md`                                                   |

### Commands

```text
deno task docs:check          offline. Prints problems and exits 1. Runs in mise run check.
deno task docs:sync           downloads every stale entry.
deno task docs:sync <name>    downloads one entry, even when it is current.
```

### Check

```text
lock     = direct dependencies from the lock file, as { "npm:preact": "10.29.8", ... }
covered  = manifest.ignore
problems = []

for entry in manifest.entries:
  for each (pkg, version) in entry.packages:
    covered += pkg
    if pkg not in lock:            problem: not a dependency; remove it from the manifest
    else if lock[pkg] != version:  problem: docs are out of date; run docs:sync
  if the entry's output path does not exist:
                                   problem: missing; run docs:sync <name>

for pkg in lock:
  if pkg not in covered:           problem: no entry; add one, or list it under ignore

print the problems, and exit 1 if there are any
```

### Sync

```text
targets = [the entry named <name>]     if a name is given
        = [every stale entry]          otherwise
stale(entry) = a package version differs from the lock, or the output path is missing

for entry in targets:
  for each pkg in entry.packages: entry.packages[pkg] = lock[pkg]
  fetched = fetch(entry)
  entry.commit = fetched.commit        # git entries only
  write manifest.json                  # after each entry, so finished work is kept
```

### Fetch

```text
fetch(entry):
  if kind is deno-doc:
    text = run "deno doc --no-config <spec>@<version>"
    write docs/reference/<name>.md: a "# <spec>@<version>" heading, the command, then text
    return

  work = new temp folder
  try:
    stage = work/out                   # build the new copy here, so a failure keeps the old docs

    if kind is git:
      url = GITHUB_BASE/<repo>/archive/refs/tags/<tag>.tar.gz    # or refs/heads/<branch>
      archive = download(url)
      root = unpack(archive)           # the archive has one top folder
      copy each file under root/<path> that matches a pages glob and no exclude glob
           into stage, keeping its relative path
      fail if nothing matched          # catches a wrong pages glob
      commit = the 40-character SHA after "comment=" in the archive's first 1024 bytes

    if kind is npm:
      meta = GET NPM_REGISTRY/<name>/<version>                    # NPM_REGISTRY comes from .npmrc
      root = unpack(download(meta.dist.tarball))
      copy each file under root that matches a files glob into stage

    delete docs/reference/<name>/ if it exists
    move stage to docs/reference/<name>/
  finally:
    delete work
```

Glob rules:

- `*` matches within one folder name.
- `**` matches any number of folders.
- `api/**/*.md` matches `api/a.md` and `api/x/y/b.md`.

### Limits

- A `ref.branch` entry fetches the branch head at sync time. If the docs on that branch change, nothing is flagged, because the check compares only package versions. Prefer tags.
- A tag template uses the version of the first package in `packages`. List only packages that share one version.
- The check covers direct dependencies only, the ones listed in the lock file's workspace section.

### Excluded from tooling

Oxlint, the formatter, the Markdown linter, and the dead-code check skip `docs/reference/`, because it holds third-party text. Separately, `deno.json` sets `"vendor": true`, which makes Deno copy remote modules into `vendor/`. That folder is source code, not docs.

### How agents use it

`AGENTS.md` tells agents to:

- Search `docs/reference/<package>/` before using a dependency's API.
- Run `deno task docs:sync` after changing a dependency version.
- Add each new dependency to `manifest.json`. The check fails until it is listed.

## Rebuilding it in another project

| Piece           | This repo                    | Another project                                                 |
| --------------- | ---------------------------- | --------------------------------------------------------------- |
| Lint engine     | oxlint with a JS plugin      | ESLint, Biome, or another linter with custom rules              |
| Lock file       | `deno.lock`                  | Your lock file, such as `package-lock.json` or `pnpm-lock.yaml` |
| GitHub source   | The company GitHub mirror    | `https://github.com`                                            |
| npm source      | `registry=` line in `.npmrc` | `https://registry.npmjs.org/` or your mirror                    |
| Deno doc source | `deno doc`                   | Drop the kind, or use your language's doc tool                  |

1. Copy the rules you want. Each rule needs its file, its test, and an entry in the plugin and the config. 34 of the 41 rules import helpers from `files.ts`, `graph.ts`, `values.ts`, or `types.ts`, so copy those too.
2. Write a manifest and a script with `check` and `sync` commands. This repo's script is about 450 lines of Deno TypeScript. The pseudocode above covers its logic.
3. Run `check` in CI alongside lint and tests. Run `sync` after each dependency version change.
4. Add a line to the agent instructions file: read the docs in the reference folder before using a dependency's API.
