#!/usr/bin/env python3
"""Compare raw tool output, truncation, RTK-style reducers, and typed output."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/rtk-output-compression-sim")
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
RETRY_TURN_TOKENS = 80_000
FUTURE_TURNS = 5


@dataclass(frozen=True)
class Scenario:
    name: str
    command_class: str
    raw_tokens: int
    critical_lines: int
    noise_ratio: float
    pass_only: bool
    structured_available: bool


@dataclass(frozen=True)
class Policy:
    name: str
    description: str
    visible_factor: float
    hidden_full: bool
    command_aware: bool
    typed: bool
    miss_base: float
    parse_retry: float


@dataclass
class Row:
    scenario: str
    policy: str
    visible_tokens: int
    hidden_bytes: int
    future_rent_tokens: int
    critical_recall: float
    expected_retry_turns: float
    dollars: float
    winner: str
    quality_winner: str


SCENARIOS = [
    Scenario("git_status_dirty_80", "git", 1_400, 12, 0.25, False, True),
    Scenario("git_diff_large", "git", 22_000, 30, 0.70, False, True),
    Scenario("rg_many_hits", "search", 18_000, 20, 0.65, False, True),
    Scenario("tsc_120_errors", "diagnostic", 28_000, 120, 0.55, False, True),
    Scenario("test_long_failure", "test", 55_000, 18, 0.82, False, True),
    Scenario("build_pass_noise", "build", 16_000, 1, 0.98, True, True),
    Scenario("npm_install_noise", "package", 44_000, 6, 0.93, False, False),
    Scenario("unknown_shell_dump", "shell", 35_000, 8, 0.88, False, False),
]

POLICIES = [
    Policy("raw_output", "raw stdout/stderr visible", 1.00, False, False, False, 0.005, 0.060),
    Policy("head_tail_truncation", "generic head/tail truncation", 0.18, True, False, False, 0.130, 0.090),
    Policy("rtk_command_reducer", "Rust Token Killer style command-aware reducer + hidden full log", 0.055, True, True, False, 0.030, 0.035),
    Policy("typed_tool_output", "native typed compact output; no shell dump", 0.035, True, True, True, 0.012, 0.020),
    Policy("quiet_status_handle", "pass/status hidden, compact failure capsule only", 0.018, True, True, True, 0.018, 0.018),
]


def visible_tokens(s: Scenario, p: Policy) -> int:
    if p.name == "typed_tool_output" and not s.structured_available:
        return int(s.raw_tokens * 0.22)
    if p.name == "quiet_status_handle" and s.pass_only:
        return 30
    if p.name == "quiet_status_handle":
        return max(120, s.critical_lines * 35)
    if p.name == "rtk_command_reducer":
        return max(160, int(s.raw_tokens * p.visible_factor), s.critical_lines * 28)
    if p.name == "typed_tool_output":
        return max(120, s.critical_lines * 22)
    return max(80, int(s.raw_tokens * p.visible_factor))


def recall(s: Scenario, p: Policy) -> float:
    if p.name == "raw_output":
        return max(0.70, 0.98 - s.raw_tokens / 250_000)
    if p.name == "head_tail_truncation":
        return max(0.35, 0.88 - s.noise_ratio * 0.45 - s.critical_lines / 400)
    if p.name == "rtk_command_reducer":
        return 0.96 if p.command_aware else 0.85
    if p.name == "typed_tool_output":
        return 0.98 if s.structured_available else 0.88
    if p.name == "quiet_status_handle":
        return 0.99 if s.pass_only else 0.965
    raise ValueError(p.name)


def retry_turns(s: Scenario, p: Policy, rec: float, visible: int) -> float:
    retry = p.parse_retry + max(0.0, 0.97 - rec) * 0.8
    if p.name == "raw_output" and visible > 25_000:
        retry += 0.16
    if p.name == "head_tail_truncation" and s.critical_lines > 20:
        retry += 0.08
    if p.name == "typed_tool_output" and not s.structured_available:
        retry += 0.10
    return round(min(1.2, retry), 3)


def dollars(visible: int, rent: int, retry: float) -> float:
    cached = rent + retry * RETRY_TURN_TOKENS
    return round(visible / 1_000_000 * INPUT_PER_MTOK + cached / 1_000_000 * CACHED_PER_MTOK, 6)


def simulate() -> list[Row]:
    rows: list[Row] = []
    for scenario in SCENARIOS:
        local: list[Row] = []
        for policy in POLICIES:
            visible = visible_tokens(scenario, policy)
            hidden = scenario.raw_tokens * 4 if policy.hidden_full else 0
            rent = visible * FUTURE_TURNS
            rec = recall(scenario, policy)
            retry = retry_turns(scenario, policy, rec, visible)
            local.append(Row(scenario.name, policy.name, visible, hidden, rent, round(rec, 3), retry, dollars(visible, rent, retry), "", ""))
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.critical_recall >= 0.94 and row.expected_retry_turns <= 0.18]
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
        "# RTK output-compression simulation",
        "",
        "Question: when should shell/tool output be raw, truncated, command-reduced, typed, or quiet?",
        "",
        "RTK here means Rust Token Killer style command-aware output reducers, not the whole harness.",
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
        "| scenario | policy | visible | hidden bytes | rent | recall | retry | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for scenario in SCENARIOS:
        for row in sorted([r for r in rows if r.scenario == scenario.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.scenario} | {row.policy} | {row.visible_tokens:,} | {row.hidden_bytes:,} | {row.future_rent_tokens:,} | {row.critical_recall:.1%} | {row.expected_retry_turns:.2f} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Typed compact tools beat shell reducers when structured output is available.",
        "- RTK-style command-aware reducers are the right shell escape-hatch lane: compact visible output plus hidden full log.",
        "- Generic head/tail truncation is not safe for high-critical-line outputs; it often hides the one line needed.",
        "- Passing build/test output should be quiet/status-only, not retained model context.",
        "- Raw output is a debug expansion, not normal provider context.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>RTK output-compression simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "rtk-output-compression-sim.md"
    json_path = REPORT_DIR / "rtk-output-compression-sim.json"
    csv_path = REPORT_DIR / "rtk-output-compression-sim.csv"
    html_path = REPORT_DIR / "rtk-output-compression-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
