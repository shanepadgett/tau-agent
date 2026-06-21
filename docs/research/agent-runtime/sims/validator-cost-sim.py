#!/usr/bin/env python3
"""Compare manual validation logs vs quiet validator capsules."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/validator-cost-sim")
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
OUTPUT_PER_MTOK = 15.00
BASE_CONTEXT = 80_000
FUTURE_TURNS = 5
RETRY_TURN_TOKENS = 80_000


@dataclass(frozen=True)
class Scenario:
    name: str
    checks: int
    pass_logs: int
    fail_logs: int
    diagnostic_lines: int
    raw_log_tokens: int
    fix_loops: int
    formatter_changes: bool
    flaky: bool = False


@dataclass(frozen=True)
class Policy:
    name: str
    description: str
    pass_visibility: str
    fail_visibility: str
    auto_run: bool
    auto_format_capsule: bool
    missed_failure_risk: float
    overfix_risk: float


@dataclass
class Row:
    scenario: str
    policy: str
    visible_tokens: int
    hidden_bytes: int
    future_rent_tokens: int
    expected_retry_turns: float
    missed_failure_risk: float
    dollars: float
    winner: str
    quality_winner: str


SCENARIOS = [
    Scenario("format_pass_only", 1, 1, 0, 0, 1_200, 0, True),
    Scenario("typescript_three_errors", 1, 0, 1, 3, 4_500, 1, False),
    Scenario("test_long_failure", 1, 0, 1, 8, 18_000, 2, False),
    Scenario("lint_autofix_then_pass", 2, 1, 1, 5, 7_500, 1, True),
    Scenario("multi_loop_debug", 4, 1, 3, 16, 42_000, 3, False),
    Scenario("flaky_fail_then_pass", 3, 2, 1, 4, 12_000, 1, False, flaky=True),
]

POLICIES = [
    Policy("manual_raw_checks", "agent runs checks and raw logs stay visible", "raw", "raw", False, False, 0.010, 0.010),
    Policy("compact_command_capsules", "agent runs checks but reducer compacts output", "summary", "compact", False, False, 0.020, 0.012),
    Policy("quiet_validators", "harness runs dirty checks; passes hidden; failures compact pinned", "hidden", "compact", True, False, 0.015, 0.008),
    Policy("quiet_validators_auto_format", "quiet validators plus formatter capsules update file state", "hidden", "compact", True, True, 0.012, 0.006),
    Policy("no_validation", "skip checks unless user asks", "none", "none", False, False, 0.180, 0.050),
]


def visible_tokens(s: Scenario, p: Policy) -> int:
    visible = 0
    if p.pass_visibility == "raw":
        visible += s.pass_logs * max(300, s.raw_log_tokens // max(1, s.checks))
    elif p.pass_visibility == "summary":
        visible += s.pass_logs * 120
    if p.fail_visibility == "raw":
        visible += s.fail_logs * max(800, s.raw_log_tokens // max(1, s.fail_logs + s.pass_logs))
    elif p.fail_visibility == "compact":
        visible += s.fail_logs * (160 + s.diagnostic_lines * 35)
    if p.auto_format_capsule and s.formatter_changes:
        visible += 220
    if p.name == "no_validation":
        visible = 0
    return visible


def retry_turns(s: Scenario, p: Policy, visible: int) -> float:
    retry = 0.0
    if p.name == "manual_raw_checks":
        retry += 0.15 * s.fix_loops + (0.08 if s.raw_log_tokens > 15_000 else 0)
    elif p.name == "compact_command_capsules":
        retry += 0.08 * s.fix_loops
    elif p.name == "quiet_validators":
        retry += 0.05 * s.fix_loops
    elif p.name == "quiet_validators_auto_format":
        retry += 0.04 * s.fix_loops - (0.05 if s.formatter_changes else 0)
    elif p.name == "no_validation":
        retry += 0.60 + 0.25 * s.fix_loops
    if s.flaky and p.auto_run:
        retry += 0.08
    if visible > 20_000:
        retry += 0.12
    return round(max(0, min(1.8, retry)), 3)


def hidden_bytes(s: Scenario, p: Policy) -> int:
    if p.name == "no_validation":
        return 0
    if p.pass_visibility == "hidden" or p.fail_visibility == "compact":
        return s.raw_log_tokens * 4
    return 0


def dollars(visible: int, rent: int, retry: float, missed_risk: float, overfix_risk: float) -> float:
    cached = rent + retry * RETRY_TURN_TOKENS + missed_risk * 6 * RETRY_TURN_TOKENS + overfix_risk * 2 * RETRY_TURN_TOKENS
    return round(visible / 1_000_000 * INPUT_PER_MTOK + cached / 1_000_000 * CACHED_PER_MTOK, 6)


def simulate() -> list[Row]:
    rows: list[Row] = []
    for scenario in SCENARIOS:
        local: list[Row] = []
        for policy in POLICIES:
            visible = visible_tokens(scenario, policy)
            rent = visible * FUTURE_TURNS
            retry = retry_turns(scenario, policy, visible)
            missed = policy.missed_failure_risk + (0.04 if scenario.flaky and policy.name == "no_validation" else 0)
            cost = dollars(visible, rent, retry, missed, policy.overfix_risk)
            local.append(Row(scenario.name, policy.name, visible, hidden_bytes(scenario, policy), rent, retry, round(missed, 3), cost, "", ""))
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.missed_failure_risk <= 0.04]
        quality_best = min(row.dollars for row in qualified)
        for row in local:
            row.winner = "winner" if row.dollars == best else ""
            row.quality_winner = "quality_winner" if row.dollars == quality_best and row in qualified else ""
        rows.extend(local)
    return rows


def write_csv(path: Path, rows: list[Row]) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def write_json(path: Path, rows: list[Row]) -> None:
    path.write_text(json.dumps({"scenarios": [asdict(s) for s in SCENARIOS], "policies": [asdict(p) for p in POLICIES], "rows": [asdict(r) for r in rows]}, indent=2))


def write_md(path: Path, rows: list[Row]) -> None:
    wins: dict[str, int] = {}
    quality: dict[str, int] = {}
    for row in rows:
        if row.winner:
            wins[row.policy] = wins.get(row.policy, 0) + 1
        if row.quality_winner:
            quality[row.policy] = quality.get(row.policy, 0) + 1
    lines = [
        "# Validator-cost simulation",
        "",
        "Question: should validation output be raw, compacted, or quiet harness-managed?",
        "",
        "## Winner counts",
        "",
        "| policy | cost wins | quality-gated wins |",
        "|---|---:|---:|",
    ]
    for name in sorted(set(wins) | set(quality)):
        lines.append(f"| {name} | {wins.get(name, 0)} | {quality.get(name, 0)} |")
    lines += [
        "",
        "## Scenario detail",
        "",
        "| scenario | policy | visible | hidden bytes | rent | retry turns | missed risk | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for scenario in SCENARIOS:
        for row in sorted([r for r in rows if r.scenario == scenario.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.scenario} | {row.policy} | {row.visible_tokens:,} | {row.hidden_bytes:,} | {row.future_rent_tokens:,} | {row.expected_retry_turns:.2f} | {row.missed_failure_risk:.1%} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Passing logs should be hidden/status-only. Keeping them visible is pure context rent.",
        "- Failure capsules need diagnostic lines, not entire logs. Hidden full log handle preserves auditability.",
        "- Quiet validators beat manual raw checks by cutting both visible rent and model-run validation loops.",
        "- Auto-format integration matters because formatter changes must refresh file capsules without asking the model to reread.",
        "- Skipping validation is cheapest only before pricing missed failures; quality gate rejects it.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Validator-cost simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "validator-cost-sim.md"
    json_path = REPORT_DIR / "validator-cost-sim.json"
    csv_path = REPORT_DIR / "validator-cost-sim.csv"
    html_path = REPORT_DIR / "validator-cost-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
