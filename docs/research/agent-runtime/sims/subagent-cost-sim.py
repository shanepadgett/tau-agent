#!/usr/bin/env python3
"""Compare parent direct work, deterministic scouts, prose subagents, and typed-patch subagents."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/subagent-cost-sim")
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
OUTPUT_PER_MTOK = 15.00
PARENT_CONTEXT = 80_000
OUTPUT_TOKENS = 650


@dataclass(frozen=True)
class Scenario:
    name: str
    breadth: float
    known_scope: float
    files_touched: int
    discovery_tokens: int
    final_context_tokens: int
    independent_lenses: int
    ambiguity: float


@dataclass(frozen=True)
class Strategy:
    name: str
    description: str
    parent_turns: float
    subagent_turns: float
    subagent_context_tokens: int
    parent_visible_tokens: int
    reread_multiplier: float
    structured_patch: bool
    miss_risk: float


@dataclass
class Row:
    scenario: str
    strategy: str
    parent_tokens: int
    subagent_tokens: int
    reread_tokens: int
    visible_tokens: int
    expected_retry_turns: float
    dollars: float
    winner: str
    quality_winner: str


SCENARIOS = [
    Scenario("known_single_file", 0.10, 0.95, 1, 1_000, 2_000, 1, 0.10),
    Scenario("broad_unknown_repo", 0.85, 0.25, 8, 28_000, 10_000, 3, 0.55),
    Scenario("frontend_backend_trace", 0.75, 0.45, 12, 36_000, 14_000, 2, 0.50),
    Scenario("web_research_synthesis", 0.90, 0.20, 0, 40_000, 8_000, 4, 0.60),
    Scenario("failing_test_path", 0.55, 0.60, 4, 16_000, 6_000, 2, 0.35),
    Scenario("large_refactor_scope", 0.70, 0.55, 25, 44_000, 18_000, 3, 0.45),
]

STRATEGIES = [
    Strategy("parent_direct", "parent does all search/read itself", 1.0, 0.0, 0, 1_000, 1.0, False, 0.035),
    Strategy("deterministic_scout", "non-model grep/LSP/tree scout returns exact files/ranges", 0.55, 0.0, 0, 800, 0.45, True, 0.030),
    Strategy("prose_subagent", "model subagent returns prose summary; parent often rereads", 0.35, 1.0, 24_000, 2_200, 0.85, False, 0.080),
    Strategy("typed_patch_subagent", "model subagent returns add/drop context patch/capsules", 0.30, 1.0, 24_000, 900, 0.35, True, 0.045),
    Strategy("parallel_typed_scouts", "parallel typed subagents for independent lenses", 0.25, 1.0, 22_000, 1_200, 0.28, True, 0.040),
]


def simulate_row(s: Scenario, st: Strategy) -> Row:
    parent_discovery = int(s.discovery_tokens * st.parent_turns * (1.2 - s.known_scope * 0.5))
    subagent_tokens = int(st.subagent_turns * st.subagent_context_tokens * max(1, s.independent_lenses if st.name == "parallel_typed_scouts" else 1))
    if st.name == "parallel_typed_scouts" and s.independent_lenses < 2:
        subagent_tokens *= 2
    reread = int(s.final_context_tokens * st.reread_multiplier)
    visible = st.parent_visible_tokens + reread + int(s.final_context_tokens * (0.35 if st.structured_patch else 0.75))
    retry = st.miss_risk + s.ambiguity * 0.10
    if st.name == "parent_direct" and s.breadth > 0.6:
        retry += 0.25
    if st.name == "prose_subagent":
        retry += 0.12 + s.ambiguity * 0.10
    if st.name == "parallel_typed_scouts" and s.independent_lenses < 2:
        retry += 0.12
    if st.name == "deterministic_scout" and s.breadth > 0.75 and s.known_scope < 0.35:
        retry += 0.10
    if s.name == "web_research_synthesis" and st.name == "deterministic_scout":
        retry += 0.55
    if s.name == "web_research_synthesis" and st.name in {"typed_patch_subagent", "parallel_typed_scouts"}:
        retry -= 0.08
    parent_tokens = int(parent_discovery + visible + PARENT_CONTEXT * (1 + st.parent_turns))
    dollars = round(
        parent_tokens / 1_000_000 * CACHED_PER_MTOK
        + subagent_tokens / 1_000_000 * INPUT_PER_MTOK
        + retry * PARENT_CONTEXT / 1_000_000 * CACHED_PER_MTOK
        + (1 + st.subagent_turns) * OUTPUT_TOKENS / 1_000_000 * OUTPUT_PER_MTOK,
        6,
    )
    return Row(s.name, st.name, parent_tokens, subagent_tokens, reread, visible, round(retry, 3), dollars, "", "")


def simulate() -> list[Row]:
    rows: list[Row] = []
    for scenario in SCENARIOS:
        local = [simulate_row(scenario, strategy) for strategy in STRATEGIES]
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.expected_retry_turns <= 0.22]
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
    path.write_text(json.dumps({"scenarios": [asdict(s) for s in SCENARIOS], "strategies": [asdict(st) for st in STRATEGIES], "rows": [asdict(r) for r in rows]}, indent=2))


def write_md(path: Path, rows: list[Row]) -> None:
    wins: dict[str, int] = {}
    quality: dict[str, int] = {}
    for row in rows:
        if row.winner:
            wins[row.strategy] = wins.get(row.strategy, 0) + 1
        if row.quality_winner:
            quality[row.strategy] = quality.get(row.strategy, 0) + 1
    lines = [
        "# Subagent-cost simulation",
        "",
        "Question: when do subagents save cost instead of creating reread/prose waste?",
        "",
        "## Winner counts",
        "",
        "| strategy | cost wins | quality-gated wins |",
        "|---|---:|---:|",
    ]
    for name in sorted(set(wins) | set(quality)):
        lines.append(f"| {name} | {wins.get(name, 0)} | {quality.get(name, 0)} |")
    lines += [
        "",
        "## Scenario detail",
        "",
        "| scenario | strategy | parent tokens | subagent tokens | reread | visible | retry | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for scenario in SCENARIOS:
        for row in sorted([r for r in rows if r.scenario == scenario.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.scenario} | {row.strategy} | {row.parent_tokens:,} | {row.subagent_tokens:,} | {row.reread_tokens:,} | {row.visible_tokens:,} | {row.expected_retry_turns:.2f} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Parent direct wins known tiny scope. Do not spawn a model for one obvious file.",
        "- Deterministic scouts are the default local discovery primitive: cheap, exact ranges, no prose tax.",
        "- Prose subagents are usually bad because parent rereads anyway and inherits summary risk.",
        "- Typed-patch subagents can win web/broad synthesis when deterministic local scouting cannot answer the question.",
        "- Parallel scouts only pay when lenses are truly independent. Otherwise they are concurrency cosplay.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Subagent-cost simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "subagent-cost-sim.md"
    json_path = REPORT_DIR / "subagent-cost-sim.json"
    csv_path = REPORT_DIR / "subagent-cost-sim.csv"
    html_path = REPORT_DIR / "subagent-cost-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
