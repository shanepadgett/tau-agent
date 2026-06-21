#!/usr/bin/env python3
"""Compare tool schema grouping/exposure policies."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/tool-schema-overhead")
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
OUTPUT_PER_MTOK = 15.00
CONTEXT_TOKENS = 80_000
OUTPUT_TOKENS = 650


@dataclass(frozen=True)
class Session:
    name: str
    turns: int
    tool_mode_switches: int
    active_tool_groups: int
    complexity: float


@dataclass(frozen=True)
class ToolPolicy:
    name: str
    description: str
    schema_tokens: int
    tools_count: int
    changes_schema_on_mode: bool
    dispatcher: bool
    behavior_retry_base: float
    wrong_tool_risk: float


@dataclass
class Row:
    session: str
    policy: str
    schema_tokens_total: int
    cached_input_tokens: int
    uncached_input_tokens: int
    cache_miss_turns: int
    expected_retry_turns: float
    wrong_tool_risk: float
    dollars: float
    winner: str
    quality_winner: str


SESSIONS = [
    Session("single_file_edit_8", 8, 0, 2, 0.20),
    Session("debug_20", 20, 2, 4, 0.55),
    Session("refactor_40", 40, 5, 5, 0.75),
    Session("research_harness_80", 80, 9, 6, 0.85),
]

POLICIES = [
    ToolPolicy("many_small_tools_all", "24 narrow tools always exposed", 18_000, 24, False, False, 0.020, 0.010),
    ToolPolicy("coherent_grouped_tools", "6 grouped tools always exposed", 10_000, 6, False, False, 0.018, 0.012),
    ToolPolicy("mode_specific_tools", "only active mode tools exposed; schema changes on mode switch", 4_500, 4, True, False, 0.025, 0.015),
    ToolPolicy("stable_all_tools_gated", "all grouped schemas stable; deterministic policy gates active operations", 12_000, 8, False, False, 0.014, 0.008),
    ToolPolicy("generic_dispatcher", "one JSON dispatcher tool", 1_200, 1, False, True, 0.120, 0.045),
    ToolPolicy("dynamic_generated_tools", "generated per-task schemas", 6_000, 5, True, False, 0.040, 0.020),
]


def miss_turns(s: Session, p: ToolPolicy) -> int:
    return min(s.turns, 1 + (s.tool_mode_switches if p.changes_schema_on_mode else 0))


def retry_turns(s: Session, p: ToolPolicy) -> float:
    retry = p.behavior_retry_base * s.turns * (0.5 + s.complexity)
    if p.dispatcher:
        retry += 0.08 * s.turns * s.complexity
    if p.tools_count > 16:
        retry += 0.03 * s.turns * s.complexity
    if p.name == "mode_specific_tools" and s.tool_mode_switches == 0:
        retry *= 0.75
    return round(min(4.0, retry), 3)


def simulate_row(s: Session, p: ToolPolicy) -> Row:
    misses = miss_turns(s, p)
    cached_schema = p.schema_tokens * max(0, s.turns - misses)
    uncached_schema = p.schema_tokens * misses
    cached_context = CONTEXT_TOKENS * max(0, s.turns - 1)
    uncached_context = CONTEXT_TOKENS
    retry = retry_turns(s, p)
    wrong = p.wrong_tool_risk * (1 + s.complexity)
    retry_cached = retry * (CONTEXT_TOKENS + p.schema_tokens)
    retry_uncached = retry * OUTPUT_TOKENS
    dollars = round(
        (cached_schema + cached_context + retry_cached) / 1_000_000 * CACHED_PER_MTOK
        + (uncached_schema + uncached_context + retry_uncached) / 1_000_000 * INPUT_PER_MTOK
        + s.turns * OUTPUT_TOKENS / 1_000_000 * OUTPUT_PER_MTOK
        + wrong * 0.10,
        6,
    )
    return Row(s.name, p.name, p.schema_tokens * s.turns, int(cached_schema + cached_context), int(uncached_schema + uncached_context), misses, retry, round(wrong, 3), dollars, "", "")


def simulate() -> list[Row]:
    rows: list[Row] = []
    for session in SESSIONS:
        local = [simulate_row(session, policy) for policy in POLICIES]
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.wrong_tool_risk <= 0.05 and row.expected_retry_turns <= max(0.8, session.turns * 0.06)]
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
    path.write_text(json.dumps({"sessions": [asdict(s) for s in SESSIONS], "policies": [asdict(p) for p in POLICIES], "rows": [asdict(r) for r in rows]}, indent=2))


def write_md(path: Path, rows: list[Row]) -> None:
    wins: dict[str, int] = {}
    quality: dict[str, int] = {}
    for row in rows:
        if row.winner:
            wins[row.policy] = wins.get(row.policy, 0) + 1
        if row.quality_winner:
            quality[row.policy] = quality.get(row.policy, 0) + 1
    lines = [
        "# Tool-schema overhead",
        "",
        "Question: should the harness expose many small tools, grouped stable tools, mode-specific tools, or a dispatcher?",
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
        "## Session detail",
        "",
        "| session | policy | schema total | cache misses | cached input | uncached input | retry turns | wrong risk | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for session in SESSIONS:
        for row in sorted([r for r in rows if r.session == session.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.session} | {row.policy} | {row.schema_tokens_total:,} | {row.cache_miss_turns} | {row.cached_input_tokens:,} | {row.uncached_input_tokens:,} | {row.expected_retry_turns:.2f} | {row.wrong_tool_risk:.1%} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Generic dispatcher is cheap on schema tokens but loses once wrong-tool/retry risk is priced.",
        "- Coherent grouped tools are the sane product shape: lower rent than many tiny tools, clearer than dispatcher.",
        "- Mode-specific schemas are token-competitive and win the quality gate here, even with some switches.",
        "- Stable all-tools plus deterministic gates remain safer when provider cache churn, policy enforcement, or mode confusion dominates.",
        "- Do not generate tool schemas per turn. Put rare guidance in tool errors/results, not schema text.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Tool-schema overhead</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "tool-schema-overhead.md"
    json_path = REPORT_DIR / "tool-schema-overhead.json"
    csv_path = REPORT_DIR / "tool-schema-overhead.csv"
    html_path = REPORT_DIR / "tool-schema-overhead.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
