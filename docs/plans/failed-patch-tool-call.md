# Failed Patch Tool Call

## 2026-06-29 turn-budget working update

Rok repeated the same `functions.patch` argument-shape failure: patch envelope was sent as a JSON object key instead of as the `input` string value.

Bad argument shape:

```json
{
  "*** Begin Patch\n*** Update File: docs/plans/turn-budget.working.md\n@@\n ...\n*** End Patch雪.": ""
}
```

Tool expected:

```json
{
  "input": "*** Begin Patch\n...\n*** End Patch"
}
```

Extra mistake: the malformed key also had stray trailing text `雪.` after `*** End Patch`.

Error:

```text
Validation failed for tool "patch": input: must have required properties input
```

## Earlier failure

Rok called `functions.patch` with the patch text as the JSON object key instead of under the required `input` property.

Bad argument shape:

```json
{
  "*** Begin Patch\n*** Add File: docs/plans/silent-command-runner-awaited-checks.spec.md\n+When ...\n*** End Patch": ""
}
```

Tool expected:

```json
{
  "input": "*** Begin Patch\n...\n*** End Patch"
}
```

Error:

```text
Validation failed for tool "patch": input: must have required properties input
```
