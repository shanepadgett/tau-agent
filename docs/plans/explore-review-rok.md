# Explore Extension Review — Rok

**Historical.** Old extension archived. Build plan: [`explore-wasm-rewrite/`](explore-wasm-rewrite/README.md). Specs: [`explore-specs/`](explore-specs/README.md). Spine that survived: adapter IR, path+name identity, pure formatters, no gate, no locators, Pi owns fs/`read` with outline hook.

Scope at time of review: `packages/agent/extensions/explore/` (~6,500 lines TS) plus its native worker `packages/agent/native/tau-ast/` (~22,000 lines Rust). Verdict first: the tools are useful and the instincts (bounded output, native parsing, outline-before-read) are right. The architecture around them is a swamp. It reads like someone kept answering "what if" questions with more machinery and never once asked "what is the spine of this system." There is no spine. There are 23 TS files and 18 Rust files holding hands in the dark.

## The core failure

This was supposed to be language-agnostic structural navigation with pluggable languages. What got built is ten hardcoded languages smeared across every feature in both processes, with the UI layer of one process re-implementing the parser of the other using regexes. There is no language interface anywhere. Not in Rust, not in TypeScript. "Adding a language" means editing `outline.rs` (5,414 lines), `discovery.rs`, `relationships.rs`, `search.rs`, `edits.rs`, a new ~1,000-line per-language Rust file, the TS registry, and then auditing 57 `language ===` conditionals in `ast-tools.ts`. That is not a plugin system. That is a punishment.

## Indictments

### 1. `createAstTools` is a 1,500-line closure pretending to be an architecture

`ast-tools.ts:269-1757`. One function. It owns: locator bookkeeping, worker protocol calls, result rendering, TUI components, orientation-gate mutation, telemetry recording, overflow handling, edit planning, post-edit verification, and thirteen tool definitions. Everything shares state through closure capture. You cannot test the outline renderer without constructing an `AstClient`, a `ToolRowStateStore`, a `TemporaryOutputStore`, an `OrientationState`, and a mutation emitter. There are no seams. This is function soup served in a single bowl the size of a bathtub.

### 2. The TypeScript side re-parses source with regexes while sitting next to a real parser

Look at `renderEntry` and `containerFrame` (`ast-tools.ts:365-546`). The Rust worker has the full tree-sitter AST. It sends signatures as strings. Then the TS side — the rendering side — runs a hand-rolled state machine over those strings: block-comment tracking, `@annotation` paren-depth counting, Rust `#[attribute]` bracket counting, Go keyword detection via `/\b(?:func|type|const|var)\b/`, Java enum member comma-vs-semicolon reconstruction (`ast-tools.ts:656-661`), nested-class brace closing with a depth stack. This is a second parser, made of regex and hope, whose job is to guess facts the first parser already knew and threw away. Any rendering decision that needs syntax knowledge belongs in the worker that has the syntax tree.

### 3. Fake generality everywhere

`ast-tools.ts:374-385` and `:556-567`: an if-condition that enumerates all ten supported languages. All of them. The condition is always true. The `else` branch below it is dead weight for a hypothetical eleventh language that can never occur because `AstLanguage` is a closed union of exactly those ten. This pattern repeats. It is the fossil record of TypeScript-first development: TS got the real code path, other languages got bolted into the condition one at a time, and nobody ever collapsed the check.

Meanwhile actual per-language differences (re-export chains, caller access) are TS-only, and the data model papers over that with tri-state strings — `sourceExport: "yes" | "no" | "unknown"`, `packageSurface`, `internalOnly` — because the schema was designed around what TypeScript can answer and every other language answers "unknown". That is a capability system done by string shrug.

### 4. The read gate is a surveillance state for a problem one `if` statement solves

`orientation-state.ts` is 280 lines of ledger: per-file fingerprint records, six kinds of "structural attempt" (`directOutline`, `symbol`, `apiCandidate`, `structuralMatch`, `relationshipLocation`, `relationshipScope`), patch fingerprints, blocked/permitted/fallback counters, and telemetry events with seven separate byte categories (`workerInputBytes`, `completeRenderedBytes`, `modelVisibleAstBytes`, `sourceBytesDeflected`, `temporaryOutputBytes`, `directReadBytes`, `overflowReadBytes`). Plus `settings.ts` glob include/exclude configuration for the gate. Plus a `/read-stats` dashboard to admire the savings.

And the gate does not even mean anything. Relationship tools grant read permission to every file they mention — target paths, candidate paths, enclosing scopes (`ast-tools.ts:1537-1575`). Run `references` once and you have washed permissions across a swath of the repo you never looked at. The gate's real semantics are "some structural tool incidentally touched this fingerprint," which is not a policy, it is ceremony. The failure mode is worse: the agent gets a hard error and a lecture, burns a turn, and retries with a ritual outline it does not want.

The stated goal was "don't let the model wholesale-read big files it has never seen." That is one rule: supported source + over N bytes + not yet read this session → return the outline with a nudge that ranged/symbol reads are open. A session `Set<string>` of read paths and about thirty lines. Everything else here — fingerprint invalidation, permission taxonomy, gate globs, telemetry cathedral — is machinery built to justify machinery.

### 5. The read cache is a homemade event-sourcing system whose event log is the chat transcript

`read.ts` + `read-cache.ts` + `full-file-knowledge.ts` + `read-snapshots.ts` + `autoread.ts`: ~1,150 lines so that a repeated read can say "unchanged" or serve a diff. To do this, every read call replays the entire session branch (`replayContextPruningState`, `buildContextEntries`), re-parses its own previous tool outputs out of the transcript (including reversing its own line-number formatting via `decodeLineNumbers`), rebuilds a "scope trust" map, and — the crown jewel — includes a hand-written 80-line unified-diff applier (`applyUnifiedDiff`) so it can reconstruct file baselines from diffs it previously served to the model.

State is stored in conversation messages and recovered by parsing them back. Versioned metadata (`ReadCacheMetaV1`) rides in tool result details. One decode bug and the model silently receives wrong file content, which is the single worst failure mode a read tool can have. All of this to avoid resending an unchanged file — which the hash-compare "unchanged" marker alone achieves with maybe 5% of the code and none of the risk. The diff mode is the expensive, dangerous part, and it saves tokens only in the narrow case where a file changed a little and the model wants the whole thing again.

### 6. Numeric locators: an addressing scheme that manufactures its own staleness problem

Session-global autoincrementing integers map to opaque worker tokens (`LocatorRecord`: id, token, path, name, stale flag, `declarationRetrieved`, worker generation). Because the numbers mean nothing, the system needs: staleness flags, generation counters, invalidation on every patch, deletion of locators whose result blocks overflowed out of visibility, post-edit re-registration of "fresh" locators verified by re-outlining and fingerprint comparison, and four different error messages for "your number is dead, go outline again." The model must carry meaningless integers with invisible lifetimes, and it learns they died by wasting a turn on an error.

A signature-based address — `path::Qualified.Name` with a kind or ordinal disambiguator — is self-describing, survives worker restarts and patches, revalidates at call time for free, and is debuggable by a human reading the transcript. If the symbol is gone, return the nearest candidates. The entire locator table, generation tracking, and stale-locator error taxonomy evaporates. "Stale-safe numeric locators" is safety against a hazard the numeric scheme itself created.

### 7. Meta noise in model-visible output

Every tool appends accounting: "exceptions: N failed, N unreadable, N oversized, parser degraded N", "limit reached: files, source bytes, depth, elapsed time", omitted-candidate counts, resolution diagnostics. `ApiCandidate` carries four separate uncertainty fields (`provenance`, `certainty`, `certaintyReason`, `uncertainty`). `AstSearchSummary` has 24 fields. `RelationshipLocation` has 20+, including three parallel arrays (`candidateLocators` / `candidatePaths` / `candidateSourceFingerprints`) — parallel arrays, indexed by position, in a codebase that lectures about type safety. The model needs to know two things: the results, and whether a limit cut them off. The rest is telemetry cosplaying as content, and every token of it is paid for on every call.

### 8. Protocol and naming rot

`PROTOCOL_VERSION = 13`, hand-bumped. The `budgets` field is typed `RecursiveOutlineBudgets` and is smuggled into `apiDiscover`, `astSearch`, `relationships`, and `planEdit` requests — the name lies about its purpose in four of five uses. Error codes exist in two spellings simultaneously and forever: `"outline_failed" | "outlineFailed" | "response_too_large" | "resultFrameTooLarge"` in one union (`orientation-state.ts:39`), handled in both conventions at every site. That is not compatibility, that is nobody ever picking one.

### 9. Duplicated validation and utility sprawl

`grep.ts` declares a typebox schema for its params, then hand-writes a second validator (`assertStructuredParams` plus six `assert*` helpers, ~70 lines) checking the same shape. Two validation systems, one input. `isRecord` is defined independently in at least three files. `autoread.ts` hand-parses event payloads (`readAutoreadRequestedEvent`, `readDetails`) that already have TypeScript types on the emitting side. The extension carries its own glob matcher, its own budget divider, its own path canonicalizer — each fine alone, together a sign nothing shares a foundation.

### 10. Post-edit verification theatre

After a locator edit, the flow is: worker plans exact byte edits → TS applies them via the patch executor → TS asks the worker to re-outline every touched file → TS compares fingerprints against `sourceFingerprintForPlan` → collects "verification diagnostics" → filters fresh locators to only those the reparse blessed (`ast-tools.ts:1058-1096`). The worker computed the plan from the exact source it fingerprinted. Applying it is deterministic. If you do not trust your own byte-range application, fix that; do not bolt a second round-trip re-parse onto every edit as a confidence ritual.

## What Rok would have built

Same product goals. Different skeleton.

### Language adapter is the spine

One trait in the worker:

```rust
trait LanguageAdapter {
    fn manifest(&self) -> Manifest; // extensions, label, capability flags
    fn declarations(&self, tree: &Tree, src: &[u8]) -> Vec<Decl>;
    fn body_range(&self, decl: &Decl) -> Option<Range>;
    fn exports(&self, tree: &Tree, src: &[u8]) -> Exports;
    fn reference_candidates(&self, tree: &Tree, src: &[u8]) -> Vec<Ref>;
}
```

Outline, search, discovery, relationships, and edits are written once against this trait. A language is one file plus one registry line. Capabilities are declared booleans in the manifest ("has re-exports", "has visibility modifiers"), so the schema never needs "unknown" strings and TypeScript stops being secretly first-class. The 5,414-line `outline.rs` becomes a ~500-line engine plus adapters.

### Rendering lives where the AST lives

The worker emits display-ready declaration text per entry. The TS side does exactly two jobs: frame results into tool output and truncate. Delete the regex re-parser, the Java enum comma logic, the Go keyword hunt, the brace-depth stacks. If a language renders wrong, you fix its adapter, next to its parser, in one process.

### Addresses, not tickets

Every structural result is addressed by `path::Qualified.Name` (kind or ordinal suffix when ambiguous). `symbol`, relationship tools, and edit tools accept these directly. Resolution happens at call time against the current file. Missing symbol → error with nearest candidates. No locator map, no generations, no staleness machinery, no "run outline again" error family. The transcript becomes self-documenting: `symbol("read.ts::createExploreReadTool")` means something six months later; `symbol(47)` never did.

### One rule for reads

Supported source file, over N bytes, not read this session → return the outline plus one line: "large file, first visit; read ranges or symbols, or re-request to confirm full read." Everything else reads normally. Repeated identical reads return "unchanged" via content hash. No diff mode, no transcript replay, no unified-diff applier, no gate settings, no permission taxonomy, no fingerprint ledger. If someone wants savings stats, count bytes served vs. file sizes in two integers.

### One result envelope

`{ text, limitHit?: string, savedTo?: path }`. Limit info appears only when a limit actually cut results, as one line, because that is the only accounting that changes the model's next move. Scan counters, byte accounting, and parse-degradation counts go to details for the TUI or nowhere.

### Files shaped like the system

```text
explore/
  index.ts           wiring only
  worker/            protocol client, one file
  tools/             one file per tool, ~100-200 lines each
  render/            shared framing/truncation helpers
  read.ts            read + large-file-first-visit rule
```

No 2,000-line files. No closures owning thirteen tools. A new contributor finds `tools/outline.ts` and understands it before lunch.

### What gets deleted outright

- `orientation-state.ts`, gate settings, `/read-stats` panel (~600 lines)
- `read-cache.ts`, `full-file-knowledge.ts`, `read-snapshots.ts`, diff/recovery modes (~700 lines)
- Locator table, staleness/generation machinery, post-edit reverification round-trip
- Autoread's custom message type and hand-rolled payload parsers (fold into plain read)
- The duplicate grep validator, duplicate `isRecord`s, dead always-true language conditionals

Rough estimate: the same user-visible capability in well under half the TypeScript and a Rust side that grows by one file per language instead of by surgery on five.

## What survives

Credit where due, briefly: outline-before-read is the right default, bounded output with session temp-file overflow is the right pattern, the native worker as a separate process is the right isolation, and the tool set (outline / symbol / search / discovery / relationships / structural edits) is the right vocabulary. The product idea is good. It is buried under a junior's fear that every edge case deserves a subsystem. The fix is not polish. It is a rebuild on the adapter spine, with the confidence to let simple rules be simple.
