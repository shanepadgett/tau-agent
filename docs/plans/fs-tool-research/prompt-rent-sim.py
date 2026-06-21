#!/usr/bin/env python3
"""Compare permanent prompt rent, shards, and tool-error guidance."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/plans/fs-tool-research/reports")
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
OUTPUT_PER_MTOK = 15.00
DYNAMIC_CONTEXT = 60_000
OUTPUT_TOKENS = 650


@dataclass(frozen=True)
class Session:
    name: str
    turns: int
    mode_switches: int
    tool_errors: int
    rare_guidance_events: int
    complexity: float


@dataclass(frozen=True)
class PromptPolicy:
    name: str
    description: str
    stable_prompt_tokens: int
    dynamic_prompt_tokens: int
    shard_tokens: int
    shard_churns_on_mode: bool
    guidance_in_tool_errors: bool
    missing_guidance_risk: float
    instruction_conflict_risk: float


@dataclass
class Row:
    session: str
    policy: str
    cached_input_tokens: int
    uncached_input_tokens: int
    prompt_tokens_total: int
    cache_miss_turns: int
    expected_retry_turns: float
    dollars: float
    winner: str
    quality_winner: str


SESSIONS = [
    Session("small_edit_8", 8, 0, 0, 0, 0.20),
    Session("debug_20", 20, 1, 2, 2, 0.55),
    Session("refactor_40", 40, 4, 4, 3, 0.75),
    Session("research_80", 80, 8, 3, 5, 0.85),
]

POLICIES = [
    PromptPolicy("giant_permanent_prompt", "everything permanent: policies, examples, edge cases", 32_000, 0, 0, False, False, 0.010, 0.060),
    PromptPolicy("medium_permanent_prompt", "moderate system prompt with common rules", 14_000, 0, 0, False, False, 0.025, 0.025),
    PromptPolicy("compact_kernel_late_runtime", "small stable kernel plus late runtime capsule", 4_000, 900, 0, False, False, 0.060, 0.008),
    PromptPolicy("kernel_plus_mode_shards", "kernel plus active mode shard; shard changes on mode switch", 4_000, 900, 2_500, True, False, 0.035, 0.012),
    PromptPolicy("kernel_tool_error_guidance", "kernel only; rare edge guidance appears in tool errors", 3_200, 700, 0, False, True, 0.045, 0.006),
    PromptPolicy("dynamic_posture_system_rewrite", "current Soul-like posture baked into system prompt", 7_000, 0, 1_200, True, False, 0.030, 0.020),
]


def cache_miss_turns(session: Session, policy: PromptPolicy) -> int:
    misses = 1
    if policy.shard_churns_on_mode:
        misses += session.mode_switches
    if policy.name == "dynamic_posture_system_rewrite":
        misses += session.mode_switches
    return min(session.turns, misses)


def retry_turns(session: Session, policy: PromptPolicy) -> float:
    missing = policy.missing_guidance_risk * session.complexity * max(1, session.rare_guidance_events)
    conflict = policy.instruction_conflict_risk * session.turns / 10
    if policy.guidance_in_tool_errors:
        missing *= 0.55 + max(0, session.rare_guidance_events - session.tool_errors) * 0.10
    if policy.name == "giant_permanent_prompt" and session.turns > 30:
        conflict += 0.18
    return round(min(2.5, missing + conflict), 3)


def simulate_row(session: Session, policy: PromptPolicy) -> Row:
    stable = policy.stable_prompt_tokens + policy.shard_tokens
    dynamic = policy.dynamic_prompt_tokens
    misses = cache_miss_turns(session, policy)
    prompt_per_turn = stable + dynamic
    total_prompt = prompt_per_turn * session.turns
    cached = stable * max(0, session.turns - misses)
    uncached_prompt = total_prompt - cached
    context_cached = DYNAMIC_CONTEXT * max(0, session.turns - 1)
    context_uncached = DYNAMIC_CONTEXT
    retry = retry_turns(session, policy)
    retry_cached = retry * (DYNAMIC_CONTEXT + stable)
    retry_uncached = retry * (dynamic + OUTPUT_TOKENS)
    dollars = round(
        (cached + context_cached + retry_cached) / 1_000_000 * CACHED_PER_MTOK
        + (uncached_prompt + context_uncached + retry_uncached) / 1_000_000 * INPUT_PER_MTOK
        + session.turns * OUTPUT_TOKENS / 1_000_000 * OUTPUT_PER_MTOK,
        6,
    )
    return Row(session.name, policy.name, int(cached + context_cached), int(uncached_prompt + context_uncached), total_prompt, misses, retry, dollars, "", "")


def simulate() -> list[Row]:
    rows: list[Row] = []
    for session in SESSIONS:
        local = [simulate_row(session, policy) for policy in POLICIES]
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.expected_retry_turns <= max(0.35, session.turns * 0.02)]
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
        "# Prompt-rent simulation",
        "",
        "Question: how much permanent prompt should live in the stable prefix?",
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
        "| session | policy | prompt total | cache misses | cached input | uncached input | retry turns | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for session in SESSIONS:
        for row in sorted([r for r in rows if r.session == session.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.session} | {row.policy} | {row.prompt_tokens_total:,} | {row.cache_miss_turns} | {row.cached_input_tokens:,} | {row.uncached_input_tokens:,} | {row.expected_retry_turns:.2f} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Permanent prompt text is rent even when cached; giant prompts only look okay when ignored future turns are cheap.",
        "- Small stable kernel plus late runtime wins normal sessions.",
        "- Tool-error guidance is a good place for rare edge-case instructions; do not prepay every turn.",
        "- Mode shards can work, but mode-switch churn must not rewrite the early system prompt.",
        "- Current Soul-style dynamic system rewrite is the wrong shape for prompt caching.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Prompt-rent simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "prompt-rent-sim.md"
    json_path = REPORT_DIR / "prompt-rent-sim.json"
    csv_path = REPORT_DIR / "prompt-rent-sim.csv"
    html_path = REPORT_DIR / "prompt-rent-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
