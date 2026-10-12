# FFF ranking follow-up

## Question and result

Why does `schemasession` sometimes omit `packages/schema/src/session.ts`, and can FFF rank it consistently without replacing its matcher?

**The native page sorter has no final tie-break. A small native patch fixes the measured omission and ordering variation on macOS and Linux arm64/glibc.** It is a prototype, not a change to the installed dependency.

## Cause and remedy

Source: `https://github.com/dmtrKovalenko/fff.git`, tag `v0.11.0`, commit `95fd777c2529fc7b4d7572dabff64cc07268f2c5`. In `crates/fff-core/src/score.rs`, `sort_and_paginate` selects a page with `select_nth_unstable_by`, then sorts it. Both comparators use total score descending and modification time descending, with nothing to distinguish equal values.

The target and its `session-*` siblings have total/base score 155 and modification time 1791780501. Equal scores do not express a preference for the shorter filename. Parallel match order and partial selection decide which tied files reach the page. With stock sorting, even one thread gives rank 2 on a ten-item page but rank 15 on a 100-item or full page. Warmup, a 250 ms delay and refreshing git status do not solve it.

`native-ranking.patch` changes the existing sorter, not the matching scores. One comparator serves both page selection and final sorting:

1. Total score descending.
2. Modification time descending.
3. Relative path byte length ascending.
4. Relative path lexical byte order ascending.

Path reads use the correct base or overflow arena. Equal-score/equal-time new files no longer win merely by insertion order. This is a ranking policy for ties, not evidence of better relevance for every query.

Single-thread matching does not fix page inconsistency. Sorting only ten returned results cannot recover an excluded target. Overfetching a fixed number has the same limitation at a larger boundary; fetching every match adds transfer and sorting cost. The native comparator fixes selection at its source.

## Verification

Fresh native release builds use Rust 1.99.0 and the default pure-Rust `ripgrep` feature for both baseline and patch. The original npm binary uses a different native build configuration; the comparisons below are between matched source builds, not against the earlier npm performance table. `build-native.ts` embeds the chosen library in a compiled Bun binary without changing installed packages.

`ranking-probe.ts` searches after scanning, after full warmup and after git refresh. Each phase uses thread counts 0 (automatic), 1 and 4, and page sizes 10, 100 and 200,000. Five fresh processes per variant, corpus and platform give 135 probes per corpus/platform.

| Check | Stock source build | Patched source build |
| --- | --- | --- |
| `schemasession`, automatic threads, page 10 | Omitted in 12/15 macOS and 5/15 Linux probes | First in 15/15 on each platform |
| `schemasession`, all thread/page/phase combinations | Rank 1, 2, 15 or omitted | First in all 270 probes across both platforms |
| `netsocket`, all combinations | Rank 4–8 | Fourth in all 270 probes across both platforms |
| Twenty named ranking targets | Several ranks vary across processes | Every target in top ten; ranks consistent in all five runs on each platform |
| Top-ten path sequence for the two probe queries | Varies | Identical across processes, phases, threads and page sizes |

File counts remain 8,729 and 95,964; query match counts remain 1,651 and 12,277. All 11 compiled smoke checks pass for the patch on each platform. All 185 native library tests pass on macOS; all 18 scoring tests pass on Linux. Two added regressions cover rotated/reversed input, partial pages, score/time priority, lexical ties and overflow-arena paths.

## Performance and limits

Same compiled `worker.ts` workload as the original spike: ten named queries and two broad queries, 120 timed warm searches. macOS values are medians of five processes per variant, alternating variant order without the Linux run overlapping. Linux values are medians of three processes per variant; baseline ran before patch, and the host was also running macOS checks. Filesystem caches were warm. These small samples are not precise slowdown estimates.

| Platform | Corpus | Build | First result, ms | Query median, ms | Query p95, ms | Peak RSS, MiB |
| --- | --- | --- | --- | --- | --- | --- |
| macOS | OpenCode | Stock | 30.1 | 0.75 | 1.64 | 60.0 |
| macOS | OpenCode | Patched | 40.9 | 0.76 | 1.54 | 60.1 |
| macOS | Kernel | Stock | 165.2 | 2.25 | 3.89 | 150.6 |
| macOS | Kernel | Patched | 159.5 | 2.33 | 4.31 | 153.1 |
| Linux | OpenCode | Stock | 48.6 | 0.81 | 1.70 | 63.6 |
| Linux | OpenCode | Patched | 51.6 | 0.81 | 1.73 | 63.7 |
| Linux | Kernel | Stock | 279.6 | 2.54 | 4.99 | 128.4 |
| Linux | Kernel | Patched | 276.5 | 2.53 | 5.42 | 128.6 |

The patch is not free: the macOS OpenCode first-result measurement rose about 11 ms, and kernel query p95 rose about 0.4 ms on both platforms. First-result time includes an empty-query search used to count files before the first named search. Memory is similar in these runs.

Not tested: x64, musl, Windows, cold caches, independent Linux checkouts, frecency/history, directory/mixed search ranking, changing corpora or broader relevance. Preserving modification-time priority means changing timestamps can still change ranks. The patch does not claim deterministic rankings while the index itself changes.

## Reproduction

Use the corpora and pinned Bun dependencies from NOTES.md. Start with a fresh ignored source clone:

```sh
git clone --depth 1 --branch v0.11.0 https://github.com/dmtrKovalenko/fff.git spikes/file-finder/.work/fff-source
git -C spikes/file-finder/.work/fff-source apply "$PWD/spikes/file-finder/native-ranking.patch"
mise exec rust@1.99.0 -- cargo test --manifest-path spikes/file-finder/.work/fff-source/Cargo.toml --locked -p fff-search --lib
mise exec rust@1.99.0 -- cargo build --manifest-path spikes/file-finder/.work/fff-source/Cargo.toml --locked --release -p fff-c
bun spikes/file-finder/build-native.ts spikes/file-finder/ranking-probe.ts spikes/file-finder/.work/fff-source/target/release/libfff_c.dylib spikes/file-finder/dist/tau-ranking-patched
spikes/file-finder/dist/tau-ranking-patched opencode "$PWD/spikes/file-finder/corpus/opencode"
spikes/file-finder/dist/tau-ranking-patched linux "$PWD/spikes/file-finder/corpus/linux"
bash spikes/file-finder/ranking-linux.sh
```

For a macOS baseline, build and embed the pristine source before applying the patch. Substitute `worker.ts` or `smoke.ts` for `ranking-probe.ts` to reproduce timing or smoke checks. Linux's script builds both variants, embeds each library, and runs ranking, timing, scoring regressions and smoke checks. It installs Rust and build dependencies inside the disposable container. Reports stay in `.work/ranking-mac/` and `.work/ranking-linux/`; earlier npm probes are `.work/ranking-probe-{1..5}.json`.

## Distribution decision

Use published, unpatched FFF first. Reconsider this native workaround if a ranking bug is opened; the patch remains spike reference. Prefer an upstream fix. Carrying the patch would require pinned native builds for each shipped platform, embedding those builds, retaining the regressions and retiring the patch when upstream includes the fix. That maintenance choice would need separate approval; no upstream issue or PR has been submitted.
