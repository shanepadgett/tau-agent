# Task 05 — Target identity resolution

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), this file, `explore-specs/cross/identity.md` (full), then engine + IR + scan on disk. **No new tests.** Live: resolve/disambiguate real symbols. `check:ts` green.

Depends on: 03 (TS adapter enough).

## Goal

One module resolving `{ path?, name, line? }` (+ directory scope) to exactly one `Decl`, or a bounded candidate list. Every symbol-targeted tool (show, relationships, impact, context, discover follow-ups) uses this and nothing else.

Spec: `explore-specs/cross/identity.md` — read it fully; it is short and normative.

## File

`packages/agent/extensions/explore/ast/identity.ts`

## API

```ts
type Target = { path?: string; name: string; line?: number };
type Candidate = {
  path: string; name: string; qualifiedName: string;
  kind: DeclKind; startLine: number; endLine: number;
  signature: string;              // byte slice, no body
};
type Resolution =
  | { kind: "resolved"; decl: Decl; path: string; ir: FileIr }
  | { kind: "candidates"; candidates: Candidate[] }   // bounded, e.g. 10
  | { kind: "notFound" };

resolveTarget(engine, scopeDir: string, target: Target, signal: AbortSignal): Promise<Resolution>
```

## Rules (from identity.md)

- `path` set → resolve within that file's IR only. Match `name` against `name` and `qualifiedName`; dotted input (`Type.method`) matches qualified forms.
- `path` absent → budgeted scan of `scopeDir` (task 02 `scan.ts`) collecting matches across files.
- `line` set → keep only candidates whose `startLine..endLine` covers that line. One rule, applied uniformly; document it in the tool descriptions later.
- Exactly one match → resolved. Multiple → candidates, never a silent pick. Zero → notFound.
- Resolution always reads current bytes through the engine cache — there is no staleness concept to handle.

## Done when

Live: same-name decls disambiguated by path/line/qualified name; cross-file ambiguity returns candidates; not-found clean; abort during scope scan respected.
