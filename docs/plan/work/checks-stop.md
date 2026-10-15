# Let the model stop after it has seen failing checks

Status: agreed and built 2026-10-14. Raised by the user after a run where the model ran the `checks` tool, saw a failure it needed permission to fix, wrote its summary, and Tau ran the checks again and sent the failure back.

**What the user gets:** when the model has already seen the checks fail after its last change, it can end its turn to ask the user something. Tau no longer forces another round.

## Today

`checksDue` in `src/core/internal/checks/check-history.ts`:

```text
due = run changed files
      and (no report since the last change, or the last report failed)
```

`settleChecks` (`src/core/internal/loop/settle-checks.ts`) runs the checks when the model ends its turn and they are due, sends failures back, and ends the run after 3 send-backs (`MAX_SEND_BACKS`). "The last report failed" keeps them due even when the model ran them itself and saw the result.

## Proposal

```text
due = run changed files and no report since the last change
model ends its turn, not due, last report failed
  → end the run with reason "checks-failed" and the failing names, no send-back
```

- A report from the `checks` tool or from Tau's own run both count as seen.
- The user still sees that checks fail: the run ends with the existing `checks-failed` notice.
- Print mode still exits with an error on `checks-failed`.
- Cost: a model can stop on a failure it could have fixed. The send-back limit already accepts that after 3 tries; this accepts it after the model has seen the failure once.
- Changes: `checksDue`, `settleChecks`, their tests, `docs/guide/project-checks.md` ("What happens" and "Limits").
