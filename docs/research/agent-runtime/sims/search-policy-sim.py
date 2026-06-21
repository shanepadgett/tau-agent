#!/usr/bin/env python3
"""Compare search/read auto-expansion policies."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/search-policy-sim")
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
OUTPUT_PER_MTOK = 15.00
BASE_CONTEXT = 80_000
EXTRA_TURN_OUTPUT = 650
FUTURE_TURNS = 5


@dataclass(frozen=True)
class Scenario:
    name: str
    bucket: str
    hits: int
    useful_files: int
    avg_file_tokens: int
    useful_range_tokens: int
    generated_or_vendor: bool
    scope_confidence: float
    discovery_turns_if_not_read: float
    wrong_context_risk: float


@dataclass(frozen=True)
class Policy:
    name: str
    description: str
    whole_threshold: int
    auto_range: bool
    auto_generated: bool
    scope_pack: bool
    aggressiveness: float


@dataclass
class Row:
    scenario: str
    policy: str
    tool_visible_tokens: int
    auto_read_tokens: int
    future_rent_tokens: int
    avoided_turns: float
    noise_tokens: int
    wrong_context_risk: float
    dollars: float
    winner: str
    quality_winner: str


SCENARIOS = [
    Scenario("single_small_owned_source", "source", 1, 1, 1_800, 500, False, 0.90, 1.0, 0.02),
    Scenario("three_small_owned_files", "source", 3, 3, 2_400, 1_200, False, 0.85, 2.0, 0.03),
    Scenario("large_owned_file_target", "source", 1, 1, 18_000, 1_000, False, 0.75, 1.2, 0.04),
    Scenario("broad_refactor_known_scope", "source", 30, 12, 2_800, 8_000, False, 0.82, 4.0, 0.05),
    Scenario("vendor_match", "vendor", 12, 1, 6_000, 900, True, 0.35, 1.5, 0.20),
    Scenario("generated_schema_match", "generated", 8, 1, 40_000, 1_400, True, 0.40, 1.5, 0.18),
    Scenario("docs_config_small", "config", 4, 2, 1_600, 900, False, 0.80, 1.5, 0.04),
    Scenario("failing_test_stack", "test", 10, 4, 3_200, 2_500, False, 0.70, 2.5, 0.06),
]

POLICIES = [
    Policy("search_only", "return hits only; model asks follow-up reads", 0, False, False, False, 0.0),
    Policy("auto_read_ranges_owned", "auto-read matched ranges for owned files", 0, True, False, False, 0.35),
    Policy("whole_small_3k", "auto-read whole owned files <=3k", 3_000, True, False, False, 0.55),
    Policy("whole_small_5k_confident", "auto-read <=5k only when scope confidence is high", 5_000, True, False, False, 0.65),
    Policy("aggressive_autoread", "auto-read all hits including generated/vendor", 20_000, True, True, False, 1.00),
    Policy("scope_pack", "repo/scope pack plus whole small owned files", 5_000, True, False, True, 0.75),
]


def simulate_row(s: Scenario, p: Policy) -> Row:
    hit_list_tokens = 120 + s.hits * 18
    noise_tokens = 0
    auto_read = 0
    wrong_risk = s.wrong_context_risk

    if p.scope_pack and not s.generated_or_vendor:
        pack_tokens = min(40_000, 1_000 + int(s.useful_range_tokens * 1.4) + s.hits * 40)
        auto_read += int(pack_tokens * s.scope_confidence)
        noise_tokens += max(0, pack_tokens - auto_read)
    elif p.auto_generated or not s.generated_or_vendor:
        if p.whole_threshold and s.avg_file_tokens <= p.whole_threshold and (p.name != "whole_small_5k_confident" or s.scope_confidence >= 0.75):
            auto_read += s.hits * s.avg_file_tokens
        elif p.auto_range:
            auto_read += min(s.hits * s.useful_range_tokens, s.hits * max(300, s.avg_file_tokens // 5))
        if p.name == "aggressive_autoread":
            noise_tokens += int(max(0, s.hits - s.useful_files) * s.avg_file_tokens * 0.70)
            wrong_risk += 0.08 if s.generated_or_vendor else 0.03
    else:
        wrong_risk += 0.02 if s.generated_or_vendor else 0

    useful_read = min(auto_read, s.useful_files * s.avg_file_tokens)
    coverage = useful_read / max(1, s.useful_files * min(s.avg_file_tokens, max(s.useful_range_tokens, 1)))
    avoided = min(s.discovery_turns_if_not_read, s.discovery_turns_if_not_read * coverage * (0.8 + s.scope_confidence * 0.3))
    if p.name == "search_only":
        avoided = 0
    if s.generated_or_vendor and not p.auto_generated:
        avoided *= 0.4
    visible = hit_list_tokens + auto_read + noise_tokens
    rent = int(visible * FUTURE_TURNS * (0.8 if p.scope_pack else 1.0))
    turn_cost = (BASE_CONTEXT * CACHED_PER_MTOK + EXTRA_TURN_OUTPUT * OUTPUT_PER_MTOK) / 1_000_000
    remaining_turns = max(0.0, s.discovery_turns_if_not_read - avoided)
    input_cost = visible / 1_000_000 * INPUT_PER_MTOK + rent / 1_000_000 * CACHED_PER_MTOK
    risk_cost = wrong_risk * 0.15
    dollars = round(input_cost + risk_cost + remaining_turns * turn_cost, 6)
    return Row(s.name, p.name, visible, auto_read, rent, round(avoided, 2), noise_tokens, round(wrong_risk, 3), dollars, "", "")


def simulate() -> list[Row]:
    rows: list[Row] = []
    for scenario in SCENARIOS:
        local = [simulate_row(scenario, policy) for policy in POLICIES]
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.wrong_context_risk <= 0.24 and not (scenario.generated_or_vendor and row.auto_read_tokens > scenario.useful_range_tokens * 2 and row.policy == "aggressive_autoread")] or local
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
        "# Search-policy simulation",
        "",
        "Question: when should search auto-read ranges or whole files?",
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
        "| scenario | policy | visible | auto-read | noise | avoided turns | wrong risk | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for scenario in SCENARIOS:
        for row in sorted([r for r in rows if r.scenario == scenario.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.scenario} | {row.policy} | {row.tool_visible_tokens:,} | {row.auto_read_tokens:,} | {row.noise_tokens:,} | {row.avoided_turns:.2f} | {row.wrong_context_risk:.1%} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Search-only is cheap per turn but loses when it causes another model turn to ask for obvious owned context.",
        "- Auto-read ranges are safest default for uncertain scope and large files.",
        "- Whole owned source/test/config <=3k is justified; <=5k needs high scope confidence.",
        "- Generated/vendor hits should stay blocked unless explicitly targeted. Aggressive auto-read looks bad once wrong-context risk is priced.",
        "- Scope packs are useful when tight; broad packs lose if they under-cover useful files or carry too much noise rent.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Search-policy simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "search-policy-sim.md"
    json_path = REPORT_DIR / "search-policy-sim.json"
    csv_path = REPORT_DIR / "search-policy-sim.csv"
    html_path = REPORT_DIR / "search-policy-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
