# Failed Patch Tool Call

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
