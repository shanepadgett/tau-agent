# Cost Report

Generates a local HTML cost report from Pi session usage.

## Command

```text
/cost-report
```

TUI only. You pick a time frame and scope, then Tau scans sessions and opens the report in your browser.

## Time frames

- Past 7 days
- Current week (Monday–Sunday, through now)
- Current month (month to date)
- Year to date
- Specific month… (pick month, then year)

## Scope

- Current project
- All sessions

All-sessions reports include a project ranking and a project filter on the session list.

## Output

Reports are written under `~/.pi/tau/cost-reports/` and opened automatically. Empty windows get a warning instead of a file.

Costs come from stored session usage estimates, including subagent tool results on parent sessions.
