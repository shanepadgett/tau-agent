# File finder

## Question and result

Does FFF work in compiled Tau binaries without copying its native library on every load? Does it beat fuzzysort and fzf-for-js on startup, repeated searches, memory and ranking?

**Compiled loading works on macOS and Linux arm64, with one cached native extraction. FFF wins first-result time and large-tree memory, not repeated-query speed or every ranking case.** fuzzysort is faster on warm queries and ranks ordinary path fragments more consistently. FFF handles all four tested typos, including transpositions the other matchers miss. Its default ranking varies between processes; one ordinary path target sometimes falls outside the top ten.

## Setup and reproduction

Bun 1.4.3 on Apple M4, 24 GiB RAM, macOS arm64 (Darwin 25.6.0); Linux arm64/glibc in the `oven/bun:1.4.3` Docker image on the same host. Pinned packages: `@ff-labs/fff-bun` 0.11.0, fuzzysort 4.0.2, fzf 0.5.2. The compiled benchmark binary occupies about 83 MiB on macOS and 93 MiB on Linux; these are whole binaries, not FFF's incremental cost.

Shallow corpora under gitignored `corpus/`:

- Linux kernel, `https://github.com/torvalds/linux.git`, commit `24a19b953e2a3d0ea5a8c4951a0ab8f32720c907`: 95,964 visible regular files.
- OpenCode, `https://github.com/anomalyco/opencode.git`, commit `03cb9b9946e0baa027d7678b690f8f352eb9a2bc`: 8,729 visible regular files.

To recreate a corpus, initialize its directory, fetch the listed URL and commit with `git fetch --depth 1`, then check out `FETCH_HEAD`. The measured trees were checked out on macOS and shared into Linux; they are not independent case-sensitive Linux checkouts.

From the repo root, with both corpora present:

```sh
bun install --cwd spikes/file-finder --frozen-lockfile
bun build --compile spikes/file-finder/worker.ts --outfile spikes/file-finder/dist/tau
bun build --compile spikes/file-finder/inspect.ts --outfile spikes/file-finder/dist/tau-inspect
bun build --compile spikes/file-finder/smoke.ts --outfile spikes/file-finder/dist/tau-smoke
mkdir -p spikes/file-finder/.work/tmp
export TMPDIR="$PWD/spikes/file-finder/.work/tmp"
spikes/file-finder/dist/tau-smoke "$PWD/spikes/file-finder/.work/smoke-fixture"
spikes/file-finder/dist/tau-inspect "$PWD/spikes/file-finder/corpus/opencode"
spikes/file-finder/dist/tau-inspect "$PWD/spikes/file-finder/corpus/linux"
bun spikes/file-finder/run.ts
bash spikes/file-finder/linux.sh
```

Linux builds require `--define FFF_LIBC='"gnu"'`; `linux.sh` supplies it. Reports, fixtures and temporary libraries stay in `.work/`. `run.ts` uses three fresh compiled processes per engine and corpus, running from `/`. FFF disables mmap caching and content indexing, with no frecency database. Both JavaScript matchers use the same git-visible regular-file inventory; fuzzysort prepares a snapshot. Search returns ten results. After the first result, FFF waits for `waitForIndexReady` before ranking and timing warm queries.

## Measurements

Each row gives the median of three process measurements. First result starts at worker entry and includes import, enumeration/index construction and the first search, but excludes Bun's process startup. Query columns are the medians of each run's median and p95 over 120 searches: ten rounds of ten named queries plus two broad queries, after warming those queries. Peak RSS is the whole process maximum from `/usr/bin/time`, not native-index memory alone. Filesystem caches are warm. Native macOS and container runs overlapped on the same host, and engine order is fixed; these are not isolated machine budgets or an OS performance comparison.

| Platform | Corpus | Engine | First result, ms | Query median, ms | Query p95, ms | Peak RSS, MiB |
| --- | --- | --- | --- | --- | --- | --- |
| macOS | OpenCode | FFF | 17.4 | 0.70 | 1.63 | 59 |
| macOS | OpenCode | fuzzysort | 82.3 | 0.09 | 0.42 | 59 |
| macOS | OpenCode | fzf | 84.0 | 2.65 | 21.51 | 115 |
| macOS | Linux | FFF | 96.9 | 2.37 | 4.02 | 159 |
| macOS | Linux | fuzzysort | 730.5 | 1.03 | 5.06 | 194 |
| macOS | Linux | fzf | 738.3 | 24.11 | 145.78 | 413 |
| Linux | OpenCode | FFF | 29.3 | 0.87 | 1.95 | 64 |
| Linux | OpenCode | fuzzysort | 140.1 | 0.10 | 0.45 | 65 |
| Linux | OpenCode | fzf | 142.1 | 3.17 | 25.17 | 106 |
| Linux | Linux | FFF | 158.7 | 2.77 | 5.26 | 131 |
| Linux | Linux | fuzzysort | 1120.1 | 1.07 | 4.98 | 190 |
| Linux | Linux | fzf | 1126.4 | 19.92 | 141.49 | 260 |

The JavaScript inventory includes two git commands, a glob walk and per-file `lstat`; this is an end-to-end comparison of these implementations, not an isolated matcher or optimal JavaScript walker comparison. `git -c core.ignoreCase=false` makes ignore matching case-sensitive without changing repo settings. Without it, macOS Git excluded 1,344 kernel paths that FFF included, mainly `.S` files matching `*.s`. Both platforms now have identical native/JavaScript inventories with no missing or extra paths.

## Loading, updates and ranking

All 11 compiled smoke checks pass on each platform: scans, regular/hidden files, gitignore, git metadata exclusion, independent indexes, and create/rename/delete updates. Watch events use absolute paths; the original relative-path assertion caused the earlier timeout.

The embedded library loads through Bun's `bun:ffi`. Each platform reused one `.bun-<uid>-<hash>` library across all six FFF benchmark processes, with unchanged name, size, inode and modification time: 5,404,416 bytes on macOS, 6,059,392 bytes on Linux. A separate macOS test started with a fresh temporary directory and confirmed the second process reused the first extraction. Linux `/proc/self/maps` shows the cached `.so`, not a memfd. This is not zero disk writes: the first load extracts a library. The per-load accumulation reported in OpenCode issue #54106 was not reproduced with these versions.

Ranking cases in `cases.ts` name eight ordinary path targets and two typo targets per corpus. Counts below are targets returned in the top ten, across the final three runs:

| Corpus | Engine | Ordinary targets, of 8 | Typo targets, of 2 |
| --- | --- | --- | --- |
| OpenCode | FFF | 7 on macOS; 7–8 on Linux | 2 |
| OpenCode | fuzzysort | 8 | 0 |
| OpenCode | fzf | 7 | 0 |
| Linux | FFF | 8 | 2 |
| Linux | fuzzysort | 8 | 1 |
| Linux | fzf | 8 | 1 |

FFF sometimes ranks `packages/schema/src/session.ts` second for `schemasession` and sometimes omits it from the top ten. Several kernel ranks also change across processes. The follow-up established the cause: equal scores and timestamps have no final deterministic tie-break, so parallel matching and partial page selection affect result order. Waiting for full warmup does not fix it. fuzzysort and fzf had stable rankings in the measured runs. FFF's typo results support a narrower claim than universally better ranking; for example, fuzzysort handles `workquue.c` but not `nvme/hsot/core.c`.

A native prototype preserves score and modification-time priority, then prefers shorter paths and sorts equal-length paths lexically. In compiled binaries on both platforms, `schemasession` ranks first in all 270 probes; all 20 case targets stay in the top ten with consistent ranks across five processes per corpus and platform. Both platforms pass the 11 smoke checks. The patch, regressions, performance costs and reproduction are in [RANKING.md](RANKING.md). The installed 0.11.0 package remains unpatched.

## Recommendation and limits

FFF is selected for its fast initial index, watcher, low large-tree memory and typo support. Try the published, unpatched package first; reconsider the tested native workaround if a ranking bug is opened. Prefer an upstream fix over maintaining native binaries. A fixed-size application rerank cannot guarantee recovery of a target already excluded from the native page. fuzzysort remains the alternative when avoiding native distribution matters more than indexing and typo recovery. fzf offers no measured advantage here.

Not tested: x64, musl, Windows, independent Linux checkouts, cold filesystem caches, library reuse across upgrades or users, concurrent first extraction, restricted/noexec temporary directories, symlink behavior, watcher overload/rescan, ignore-rule changes, content search, persistence/frecency, cancellation, evolving query prefixes or real TUI interaction. Twenty hand-picked ranking cases are not a general relevance benchmark. This spike establishes compiled viability and these workloads' tradeoffs, not a production file-finder design.
