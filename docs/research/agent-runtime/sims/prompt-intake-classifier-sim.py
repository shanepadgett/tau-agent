#!/usr/bin/env python3
"""Simulate prompt-intake metadata classifier policies."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/prompt-intake-classifier-sim")
CLASSIFIER_INPUT_PER_MTOK = 0.20
CLASSIFIER_OUTPUT_PER_MTOK = 0.60
CACHED_PER_MTOK = 0.30
RETRY_TURN_TOKENS = 80_000


@dataclass(frozen=True)
class Session:
    name: str
    user_prompts: int
    durable_preferences: int
    corrections: int
    reversals: int
    approvals: int
    scope_changes: int
    ambiguity: float


@dataclass(frozen=True)
class Policy:
    name: str
    description: str
    classifier_tokens: int
    output_tokens: int
    precision: float
    recall: float
    confirm_high_impact: bool
    prompts_user_rate: float
    annoyance_risk: float


@dataclass
class Row:
    session: str
    policy: str
    classifier_tokens: int
    user_confirmations: float
    metadata_recall: float
    false_durable_risk: float
    missed_correction_risk: float
    annoyance_risk: float
    expected_retry_turns: float
    dollars: float
    winner: str
    quality_winner: str


SESSIONS = [
    Session("small_edit", 3, 0, 0, 0, 1, 0, 0.10),
    Session("debug_with_correction", 8, 1, 2, 0, 1, 1, 0.35),
    Session("long_research", 24, 4, 4, 2, 3, 5, 0.55),
    Session("preference_heavy", 16, 6, 2, 1, 2, 2, 0.45),
    Session("scope_churn", 18, 2, 3, 4, 2, 6, 0.65),
]

POLICIES = [
    Policy("none", "no side classifier; compaction infers from transcript", 0, 0, 0.0, 0.0, False, 0.0, 0.0),
    Policy("regex_only", "regex/keyword rules only", 40, 8, 0.72, 0.45, False, 0.0, 0.0),
    Policy("cheap_prompt_classifier", "cheap prompt-only classifier, no user confirmation", 220, 32, 0.86, 0.78, False, 0.0, 0.0),
    Policy("classifier_confirm_high_impact", "classifier plus tiny confirm menu for durable/high-impact labels", 240, 36, 0.94, 0.82, True, 0.18, 0.020),
    Policy("always_ask_user", "ask user to classify every important prompt", 80, 12, 0.98, 0.88, True, 0.75, 0.120),
]


def important_labels(s: Session) -> int:
    return s.durable_preferences + s.corrections + s.reversals + s.approvals + s.scope_changes


def simulate_row(s: Session, p: Policy) -> Row:
    labels = important_labels(s)
    classifier_tokens = s.user_prompts * (p.classifier_tokens + p.output_tokens)
    recall = p.recall * (1 - s.ambiguity * 0.10)
    precision = p.precision * (1 - s.ambiguity * 0.08)
    if p.name == "none":
        recall = max(0.25, 0.45 - s.ambiguity * 0.20)
        precision = 0.70
    false_durable = max(0.0, (1 - precision) * max(1, s.durable_preferences) * (0.35 if p.confirm_high_impact else 1.0))
    missed_correction = max(0.0, (1 - recall) * (s.corrections + s.reversals + s.scope_changes))
    confirmations = labels * p.prompts_user_rate
    annoyance = p.annoyance_risk * confirmations
    retry = min(3.0, missed_correction * 0.18 + false_durable * 0.22 + annoyance * 0.10)
    dollars = round(
        s.user_prompts * p.classifier_tokens / 1_000_000 * CLASSIFIER_INPUT_PER_MTOK
        + s.user_prompts * p.output_tokens / 1_000_000 * CLASSIFIER_OUTPUT_PER_MTOK
        + retry * RETRY_TURN_TOKENS / 1_000_000 * CACHED_PER_MTOK,
        6,
    )
    return Row(s.name, p.name, classifier_tokens, round(confirmations, 2), round(recall, 3), round(false_durable, 3), round(missed_correction, 3), round(annoyance, 3), round(retry, 3), dollars, "", "")


def simulate() -> list[Row]:
    rows: list[Row] = []
    for session in SESSIONS:
        local = [simulate_row(session, policy) for policy in POLICIES]
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.false_durable_risk <= 0.35 and row.missed_correction_risk <= max(1.0, important_labels(next(s for s in SESSIONS if s.name == row.session)) * 0.25) and row.annoyance_risk <= 0.60]
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
        "# Prompt-intake classifier simulation",
        "",
        "Question: is a cheap side classifier worth running on each user prompt?",
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
        "| session | policy | classifier tokens | confirmations | recall | false durable | missed correction | annoyance | retry turns | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for session in SESSIONS:
        for row in sorted([r for r in rows if r.session == session.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.session} | {row.policy} | {row.classifier_tokens:,} | {row.user_confirmations:.2f} | {row.metadata_recall:.1%} | {row.false_durable_risk:.2f} | {row.missed_correction_risk:.2f} | {row.annoyance_risk:.2f} | {row.expected_retry_turns:.2f} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- No classifier is cheap only until missed corrections/scope changes cause retries or bad compaction.",
        "- Regex-only is useful as a floor but misses reversals and nuanced corrections.",
        "- Cheap prompt-only classifier is worth testing; token cost is tiny compared with one retry turn.",
        "- High-impact confirmation is the safer product shape for durable preferences and reversals.",
        "- Always asking users is accurate but annoying. Gate confirmations by confidence and impact.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Prompt-intake classifier simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "prompt-intake-classifier-sim.md"
    json_path = REPORT_DIR / "prompt-intake-classifier-sim.json"
    csv_path = REPORT_DIR / "prompt-intake-classifier-sim.csv"
    html_path = REPORT_DIR / "prompt-intake-classifier-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
