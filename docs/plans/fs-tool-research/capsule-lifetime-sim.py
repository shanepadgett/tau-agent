#!/usr/bin/env python3
"""Simulate capsule lifecycle policies: raw retention, prune, replace, budget, MRC."""

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
OUTPUT_TOKENS = 650
RETRY_CONTEXT_TOKENS = 80_000


@dataclass(frozen=True)
class Event:
    turn: int
    kind: str
    tokens: int
    critical: int
    exact: int
    stale_after: int = 0


@dataclass(frozen=True)
class Session:
    name: str
    turns: int
    events: tuple[Event, ...]


@dataclass(frozen=True)
class Policy:
    name: str
    description: str
    mode: str
    budget: int
    recall_base: float
    exact_base: float
    hidden_refs: bool


@dataclass
class State:
    visible: int = 0
    hidden_bytes: int = 0
    stale_visible: int = 0
    critical: int = 0
    exact: int = 0
    active_search: int = 0
    active_reads: int = 0
    active_failures: int = 0
    decisions: int = 0
    probes: int = 0
    unresolved_failure_hidden: int = 0
    prunes: int = 0


@dataclass
class Row:
    session: str
    policy: str
    visible_cumulative_tokens: int
    visible_peak_tokens: int
    visible_end_tokens: int
    stale_visible_tokens: int
    hidden_bytes: int
    prunes: int
    critical_recall: float
    exact_recall: float
    unresolved_failure_visible: str
    expected_retry_turns: float
    dollars: float
    winner: str
    quality_winner: str


POLICIES = [
    Policy("raw_accumulate", "append every raw tool result/message forever", "raw", 0, 0.95, 0.92, False),
    Policy("manual_prune_every_10", "raw-ish context with manual prune every 10 turns", "manual", 0, 0.91, 0.86, True),
    Policy("auto_replace_capsules", "reads cover searches, edits supersede reads, passes resolve failures", "replace", 0, 0.94, 0.91, True),
    Policy("budgeted_projector_40k", "auto replacement plus hard visible budget and refs", "budget", 40_000, 0.955, 0.90, True),
    Policy("pi_mrc_keep_ref_drop", "KEEP/REF/DROP compact anchors plus hidden evidence", "mrc", 18_000, 0.925, 0.965, True),
    Policy("aggressive_drop", "drop old capsules aggressively; keep only latest current state", "drop", 10_000, 0.78, 0.82, True),
]


def e(turn: int, kind: str, tokens: int, critical: int, exact: int, stale_after: int = 0) -> Event:
    return Event(turn, kind, tokens, critical, exact, stale_after)


def sessions() -> list[Session]:
    small = Session("small_edit_8", 8, (
        e(1, "user", 300, 2, 0), e(2, "search", 900, 1, 0, 500), e(3, "read", 2_400, 3, 2),
        e(4, "edit", 500, 1, 1, 1_200), e(5, "validator_pass", 1_200, 0, 0, 1_200), e(6, "decision", 240, 1, 0),
        e(7, "assistant", 350, 0, 0), e(8, "final", 200, 0, 0),
    ))
    debug = Session("debug_loop_24", 24, (
        e(1, "user", 500, 3, 0), e(2, "search", 3_000, 3, 1, 1_200), e(3, "read", 5_500, 5, 3),
        e(4, "probe", 3_500, 2, 1, 1_500), e(5, "validator_fail", 12_000, 6, 4), e(6, "read", 4_000, 3, 2),
        e(7, "edit", 1_200, 2, 1, 2_000), e(8, "validator_fail", 8_000, 4, 3, 4_000), e(9, "probe", 4_500, 3, 2, 2_500),
        e(10, "decision", 600, 2, 0), e(11, "edit", 1_000, 2, 1, 2_000), e(12, "validator_fail", 4_000, 3, 2, 2_500),
        e(13, "read", 2_600, 2, 1), e(14, "edit", 800, 1, 1, 1_000), e(15, "validator_pass", 10_000, 0, 0, 10_000),
        e(16, "decision", 500, 2, 0), e(17, "probe", 1_800, 1, 1, 1_200), e(18, "validator_pass", 6_000, 0, 0, 6_000),
        e(19, "read", 3_000, 2, 1), e(20, "edit", 900, 1, 1, 1_200), e(21, "validator_pass", 4_000, 0, 0, 4_000),
        e(22, "decision", 400, 1, 0), e(23, "assistant", 500, 0, 0), e(24, "final", 250, 0, 0),
    ))
    refactor_events = [e(1, "user", 600, 4, 0)]
    for turn in range(2, 41):
        if turn % 9 == 0:
            refactor_events.append(e(turn, "validator_fail", 9_000, 5, 4, 3_000))
        elif turn % 10 == 0:
            refactor_events.append(e(turn, "validator_pass", 7_000, 0, 0, 7_000))
        elif turn % 5 == 0:
            refactor_events.append(e(turn, "edit", 1_600, 3, 2, 2_500))
        elif turn % 3 == 0:
            refactor_events.append(e(turn, "read", 6_000, 5, 3))
        elif turn % 4 == 0:
            refactor_events.append(e(turn, "search", 4_000, 3, 1, 1_500))
        else:
            refactor_events.append(e(turn, "decision", 550, 2, 0))
    refactor = Session("refactor_40", 40, tuple(refactor_events))

    research_events = [e(1, "user", 700, 4, 0)]
    for turn in range(2, 81):
        if turn % 11 == 0:
            research_events.append(e(turn, "web", 5_500, 5, 2, 2_000))
        elif turn % 13 == 0:
            research_events.append(e(turn, "validator_pass", 2_000, 0, 0, 2_000))
        elif turn % 7 == 0:
            research_events.append(e(turn, "read", 7_000, 5, 3))
        elif turn % 5 == 0:
            research_events.append(e(turn, "probe", 3_200, 2, 1, 1_500))
        elif turn % 3 == 0:
            research_events.append(e(turn, "search", 4_500, 3, 1, 2_000))
        else:
            research_events.append(e(turn, "decision", 650, 2, 0))
    research = Session("research_80", 80, tuple(research_events))
    return [small, debug, refactor, research]


def add_event(state: State, event: Event, policy: Policy) -> None:
    state.critical += event.critical
    state.exact += event.exact
    if policy.hidden_refs:
        state.hidden_bytes += event.tokens * 4

    if policy.mode == "raw":
        state.visible += event.tokens
        state.stale_visible += event.stale_after
        if event.kind == "validator_fail":
            state.active_failures += event.tokens
        if event.kind == "validator_pass":
            state.active_failures = 0
        return

    if policy.mode == "manual":
        state.visible += int(event.tokens * 0.75)
        state.stale_visible += int(event.stale_after * 0.65)
        if event.turn % 10 == 0:
            pruned = int(state.visible * 0.35)
            state.visible -= pruned
            state.stale_visible = int(state.stale_visible * 0.45)
            state.prunes += 1
        if event.kind == "validator_fail":
            state.active_failures += int(event.tokens * 0.5)
        if event.kind == "validator_pass":
            state.active_failures = 0
        return

    if event.kind == "search":
        state.active_search += compact(event, policy)
    elif event.kind in {"read", "web"}:
        state.active_reads += compact(event, policy)
        state.active_search = int(state.active_search * (0.25 if policy.mode != "drop" else 0.05))
    elif event.kind == "probe":
        state.probes += compact(event, policy)
    elif event.kind == "edit":
        state.active_reads = int(state.active_reads * (0.55 if policy.mode != "drop" else 0.20))
        state.probes = int(state.probes * 0.50)
        state.active_reads += compact(event, policy)
    elif event.kind == "validator_fail":
        state.active_failures += compact(event, policy)
    elif event.kind == "validator_pass":
        state.active_failures = 0
        state.probes = int(state.probes * 0.45)
    elif event.kind in {"decision", "user"}:
        state.decisions += compact(event, policy)
    else:
        state.decisions += compact(event, policy) // 2

    if policy.mode == "drop":
        state.active_search = min(state.active_search, 250)
        state.active_reads = min(state.active_reads, 1_200)
        state.probes = min(state.probes, 250)
        state.decisions = min(state.decisions, 1_200)
    state.visible = state.active_search + state.active_reads + state.active_failures + state.decisions + state.probes
    if event.stale_after:
        state.stale_visible += int(event.stale_after * stale_factor(policy))
    apply_budget(state, policy)


def compact(event: Event, policy: Policy) -> int:
    if policy.mode == "replace":
        return max(80, int(event.tokens * 0.28))
    if policy.mode == "budget":
        return max(70, int(event.tokens * 0.22))
    if policy.mode == "mrc":
        return max(45, int(event.tokens * 0.10 + event.critical * 18 + event.exact * 8))
    if policy.mode == "drop":
        return max(25, int(event.tokens * 0.06 + event.critical * 10))
    return event.tokens


def stale_factor(policy: Policy) -> float:
    if policy.mode == "replace":
        return 0.08
    if policy.mode == "budget":
        return 0.04
    if policy.mode == "mrc":
        return 0.02
    if policy.mode == "drop":
        return 0.01
    return 0.50


def apply_budget(state: State, policy: Policy) -> None:
    if not policy.budget or state.visible <= policy.budget:
        return
    over = state.visible - policy.budget
    for attr in ["active_search", "probes", "active_reads", "decisions"]:
        current = getattr(state, attr)
        cut = min(current, max(over, int(current * 0.35)))
        setattr(state, attr, current - cut)
        over -= cut
        state.prunes += 1
        if over <= 0:
            break
    state.visible = state.active_search + state.active_reads + state.active_failures + state.decisions + state.probes
    state.stale_visible = int(state.stale_visible * 0.70)


def quality_metrics(session: Session, policy: Policy, state: State, peak: int, cumulative: int) -> tuple[float, float, float]:
    pressure = max(0, peak - 80_000) / 180_000
    density = max(0, state.critical - 180) / 900
    stale_share = state.stale_visible / max(1, cumulative)
    failure_penalty = 0.12 if state.active_failures and policy.mode == "drop" else 0.0
    critical = max(0.45, policy.recall_base - pressure * 0.25 - density * 0.06 - failure_penalty)
    exact = max(0.45, policy.exact_base - pressure * 0.20 - density * 0.05)
    retry = min(session.turns * 0.35, (1 - critical) * min(1, state.critical / 120) * session.turns * 0.10 + (1 - exact) * min(1, state.exact / 80) * session.turns * 0.08 + stale_share * session.turns * 0.55 + failure_penalty * session.turns)
    return round(critical, 4), round(exact, 4), round(retry, 3)


def simulate_session_policy(session: Session, policy: Policy) -> Row:
    state = State()
    by_turn = {event.turn: event for event in session.events}
    visible_values: list[int] = []
    for turn in range(1, session.turns + 1):
        event = by_turn.get(turn)
        if event:
            add_event(state, event, policy)
        visible_values.append(state.visible)
    cumulative = sum(visible_values)
    peak = max(visible_values) if visible_values else 0
    end = visible_values[-1] if visible_values else 0
    critical, exact, retry = quality_metrics(session, policy, state, peak, cumulative)
    dollars = round(
        cumulative / 1_000_000 * INPUT_PER_MTOK
        + retry * RETRY_CONTEXT_TOKENS / 1_000_000 * CACHED_PER_MTOK
        + session.turns * OUTPUT_TOKENS / 1_000_000 * OUTPUT_PER_MTOK,
        6,
    )
    unresolved_visible = "yes" if state.active_failures > 0 and policy.mode != "drop" else ("hidden" if state.active_failures > 0 else "none")
    return Row(session.name, policy.name, cumulative, peak, end, state.stale_visible, state.hidden_bytes, state.prunes, critical, exact, unresolved_visible, retry, dollars, "", "")


def simulate() -> list[Row]:
    rows: list[Row] = []
    for session in sessions():
        local = [simulate_session_policy(session, policy) for policy in POLICIES]
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.critical_recall >= 0.92 and row.exact_recall >= 0.88 and row.unresolved_failure_visible != "hidden"] or local
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
    path.write_text(json.dumps({"policies": [asdict(p) for p in POLICIES], "sessions": [asdict(s) for s in sessions()], "rows": [asdict(r) for r in rows]}, indent=2))


def write_md(path: Path, rows: list[Row]) -> None:
    wins: dict[str, int] = {}
    quality: dict[str, int] = {}
    for row in rows:
        if row.winner:
            wins[row.policy] = wins.get(row.policy, 0) + 1
        if row.quality_winner:
            quality[row.policy] = quality.get(row.policy, 0) + 1
    lines = [
        "# Capsule-lifetime simulation",
        "",
        "Question: how should context capsules age, supersede, prune, and resolve?",
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
        "| session | policy | cumulative visible | peak | end | stale visible | hidden bytes | prunes | recall | exact | failures | retry | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---|",
    ]
    for session in sessions():
        for row in sorted([r for r in rows if r.session == session.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.session} | {row.policy} | {row.visible_cumulative_tokens:,} | {row.visible_peak_tokens:,} | {row.visible_end_tokens:,} | {row.stale_visible_tokens:,} | {row.hidden_bytes:,} | {row.prunes} | {row.critical_recall:.1%} | {row.exact_recall:.1%} | {row.unresolved_failure_visible} | {row.expected_retry_turns:.2f} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Raw accumulation is simple and cache-friendly but pays huge visible rent and carries stale evidence.",
        "- Manual prune is too late and too blunt; pruning has to be tied to supersession/resolution events.",
        "- Auto-replace capsules are the safe default: reads cover searches, edits supersede reads, passes resolve failures.",
        "- Budgeted projection is the safer long-session fallback when MRC lookup UX is not trustworthy.",
        "- MRC KEEP/REF/DROP wins the quality-gated cost lane here, but only if lookup UX and critical-fact gates are solid.",
        "- Aggressive drop looks cheap but fails quality because it under-remembers and can hide unresolved failures.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Capsule-lifetime simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "capsule-lifetime-sim.md"
    json_path = REPORT_DIR / "capsule-lifetime-sim.json"
    csv_path = REPORT_DIR / "capsule-lifetime-sim.csv"
    html_path = REPORT_DIR / "capsule-lifetime-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
