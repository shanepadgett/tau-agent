#!/usr/bin/env python3
"""Simulate raw transcript vs deterministic context projection."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/plans/fs-tool-research/reports")

MAIN_INPUT_PER_MTOK = 3.00
MAIN_CACHED_PER_MTOK = 0.30
MAIN_OUTPUT_PER_MTOK = 15.00
SUMMARY_INPUT_PER_MTOK = 1.25
SUMMARY_OUTPUT_PER_MTOK = 5.00
CLASSIFIER_INPUT_PER_MTOK = 0.20
CLASSIFIER_OUTPUT_PER_MTOK = 0.60
CHARS_PER_TOKEN = 4
OUTPUT_TOKENS_PER_TURN = 650
ADAPTIVE_RAW_THRESHOLD = 24_000


@dataclass(frozen=True)
class Event:
    turn: int
    kind: str
    tokens: int
    critical_facts: int = 0
    exact_facts: int = 0
    preference_facts: int = 0
    stale_risk_tokens: int = 0
    label: str = ""


@dataclass(frozen=True)
class Session:
    name: str
    turns: int
    events: tuple[Event, ...]


@dataclass(frozen=True)
class Strategy:
    name: str
    description: str
    model_compaction: bool
    classifier: bool
    hidden_refs: bool
    stable_cache_share: float
    critical_base: float
    exact_base: float
    false_preference_rate: float
    stale_visibility_factor: float


@dataclass
class ProjectionState:
    raw_tokens: int = 0
    raw_buffer_tokens: int = 0
    summary_tokens: int = 0
    active_file_refs: int = 0
    active_search_refs: int = 0
    active_failure_refs: int = 0
    decisions: int = 0
    preferences: int = 0
    user_turns: int = 0
    critical_facts: int = 0
    exact_facts: int = 0
    stale_risk_tokens: int = 0
    summary_rewrite: bool = False
    compaction_calls: int = 0
    compaction_input_tokens: int = 0
    compaction_output_tokens: int = 0
    classifier_calls: int = 0
    classifier_input_tokens: int = 0
    classifier_output_tokens: int = 0
    hidden_bytes: int = 0


@dataclass
class TurnRow:
    session: str
    strategy: str
    turn: int
    visible_tokens: int
    cached_read_tokens: int
    uncached_tokens: int
    compaction_call: int
    classifier_call: int
    hidden_bytes: int
    dollars: float


@dataclass
class SummaryRow:
    session: str
    strategy: str
    turns: int
    visible_cumulative_tokens: int
    visible_peak_tokens: int
    visible_end_tokens: int
    cached_read_tokens: int
    uncached_tokens: int
    cache_read_share: float
    hidden_bytes: int
    compaction_calls: int
    compaction_input_tokens: int
    compaction_output_tokens: int
    classifier_calls: int
    classifier_input_tokens: int
    classifier_output_tokens: int
    critical_fact_recall: float
    exact_recall_success: float
    false_preference_risk: float
    stale_visible_share: float
    expected_retry_turns: float
    dollars_before_retry: float
    retry_dollars: float
    dollars: float
    winner: str
    quality_winner: str


STRATEGIES = [
    Strategy(
        "raw_retained_transcript",
        "append-only full transcript/tool output; cache-friendly but pays rent forever",
        model_compaction=False,
        classifier=False,
        hidden_refs=False,
        stable_cache_share=1.0,
        critical_base=0.99,
        exact_base=0.97,
        false_preference_rate=0.020,
        stale_visibility_factor=1.0,
    ),
    Strategy(
        "adaptive_raw_then_mrc",
        "keep raw append-only under 24k, then switch to KEEP/REF/DROP projection",
        model_compaction=False,
        classifier=False,
        hidden_refs=True,
        stable_cache_share=0.25,
        critical_base=0.940,
        exact_base=0.960,
        false_preference_rate=0.012,
        stale_visibility_factor=0.12,
    ),
    Strategy(
        "rolling_model_summary",
        "periodic model summary plus recent raw buffer; cheap context, lossy exact recall",
        model_compaction=True,
        classifier=False,
        hidden_refs=False,
        stable_cache_share=0.70,
        critical_base=0.84,
        exact_base=0.38,
        false_preference_rate=0.060,
        stale_visibility_factor=0.18,
    ),
    Strategy(
        "vcc_source_view",
        "raw event log as truth; deterministic source-coordinate view with expandable records",
        model_compaction=False,
        classifier=False,
        hidden_refs=True,
        stable_cache_share=0.45,
        critical_base=0.955,
        exact_base=0.935,
        false_preference_rate=0.012,
        stale_visibility_factor=0.04,
    ),
    Strategy(
        "pi_vcc_sections",
        "deterministic sections: goal, files/changes, outstanding context, preferences, brief transcript",
        model_compaction=False,
        classifier=False,
        hidden_refs=True,
        stable_cache_share=0.35,
        critical_base=0.935,
        exact_base=0.870,
        false_preference_rate=0.015,
        stale_visibility_factor=0.03,
    ),
    Strategy(
        "pi_mrc_keep_ref_drop",
        "KEEP critical facts, REF hidden evidence, DROP noise; smallest visible view with lookup burden",
        model_compaction=False,
        classifier=False,
        hidden_refs=True,
        stable_cache_share=0.25,
        critical_base=0.925,
        exact_base=0.965,
        false_preference_rate=0.010,
        stale_visibility_factor=0.015,
    ),
    Strategy(
        "hybrid_sections_prompt_classifier",
        "pi-vcc-style deterministic sections plus cheap prompt-only classifier metadata",
        model_compaction=False,
        classifier=True,
        hidden_refs=True,
        stable_cache_share=0.40,
        critical_base=0.970,
        exact_base=0.915,
        false_preference_rate=0.004,
        stale_visibility_factor=0.02,
    ),
]


def e(turn: int, kind: str, tokens: int, critical: int = 0, exact: int = 0, prefs: int = 0, stale: int = 0, label: str = "") -> Event:
    return Event(turn, kind, tokens, critical, exact, prefs, stale, label)


def build_sessions() -> list[Session]:
    small_edit = Session("small_edit_8", 8, (
        e(1, "user", 320, 2, label="request"),
        e(2, "search", 900, 1, label="find target"),
        e(3, "read", 2_600, 3, 2, label="small file"),
        e(4, "assistant", 450, label="plan"),
        e(5, "edit", 700, 1, 1, label="patch"),
        e(6, "validator_pass", 1_400, stale=1_400, label="clean check log"),
        e(7, "decision", 220, 1, label="done"),
        e(8, "assistant", 350, label="final"),
    ))

    broad_refactor = Session("broad_refactor_18", 18, (
        e(1, "user", 520, 3, label="rename API"),
        e(2, "tree", 1_600, 1, label="repo slice"),
        e(3, "search", 5_500, 4, 1, stale=2_000, label="rg old API"),
        e(4, "read", 7_000, 8, 4, label="core files"),
        e(5, "read", 9_000, 8, 5, label="tests"),
        e(6, "decision", 550, 2, label="scope"),
        e(7, "edit", 2_400, 4, 3, label="batch edit"),
        e(8, "validator_fail", 8_500, 6, 4, label="type errors"),
        e(9, "read", 3_800, 4, 2, label="failing file"),
        e(10, "edit", 1_600, 3, 2, label="fix types"),
        e(11, "validator_fail", 5_800, 4, 3, stale=3_000, label="remaining tests"),
        e(12, "read", 4_200, 4, 2, label="test helper"),
        e(13, "edit", 1_900, 3, 2, label="test fix"),
        e(14, "validator_pass", 9_000, stale=9_000, label="clean logs"),
        e(15, "user", 280, 1, prefs=1, label="style preference"),
        e(16, "decision", 500, 2, label="drop old alias"),
        e(17, "validator_pass", 3_000, stale=3_000, label="format pass"),
        e(18, "assistant", 500, label="final"),
    ))

    debug_loop = Session("debug_loop_22", 22, (
        e(1, "user", 460, 3, label="bug report"),
        e(2, "search", 2_800, 3, label="find code path"),
        e(3, "read", 5_500, 6, 4, label="implementation"),
        e(4, "probe", 3_200, 3, 2, label="repro probe"),
        e(5, "validator_fail", 12_000, 6, 5, label="failing suite"),
        e(6, "read", 4_000, 4, 3, label="dependency"),
        e(7, "edit", 1_300, 2, 2, label="attempt 1"),
        e(8, "validator_fail", 14_000, 7, 5, stale=6_000, label="still broken"),
        e(9, "probe", 4_500, 4, 3, label="state dump"),
        e(10, "decision", 600, 2, label="root cause"),
        e(11, "edit", 1_500, 3, 2, label="attempt 2"),
        e(12, "validator_fail", 7_500, 4, 3, stale=5_000, label="one failure"),
        e(13, "read", 2_800, 3, 2, label="edge case"),
        e(14, "edit", 900, 2, 1, label="fix"),
        e(15, "validator_pass", 10_500, stale=10_500, label="pass log"),
        e(16, "user", 300, 1, label="ask why"),
        e(17, "assistant", 900, 2, label="explain"),
        e(18, "probe", 2_000, 1, 1, stale=1_500, label="sanity"),
        e(19, "validator_pass", 8_000, stale=8_000, label="full check"),
        e(20, "decision", 450, 2, label="guardrail"),
        e(21, "edit", 700, 1, 1, label="cleanup"),
        e(22, "assistant", 500, label="final"),
    ))

    research_design = Session("research_design_40", 40, tuple(
        [
            e(1, "user", 700, 4, prefs=1, label="research goal"),
            e(2, "web", 6_000, 5, 2, label="provider docs"),
            e(3, "web", 5_500, 5, 2, label="baseline tools"),
            e(4, "read", 7_000, 6, 3, label="reference repo"),
            e(5, "decision", 900, 4, label="architecture bet"),
            e(6, "user", 360, 2, prefs=1, label="correction"),
            e(7, "web", 6_500, 5, 2, stale=2_000, label="more docs"),
            e(8, "read", 8_500, 6, 4, label="compactor source"),
            e(9, "decision", 800, 3, label="compaction model"),
            e(10, "search", 4_500, 4, 1, stale=1_500, label="repo search"),
            e(11, "read", 6_500, 5, 3, label="tool impl"),
            e(12, "decision", 700, 3, label="hidden handles"),
            e(13, "user", 300, 1, prefs=1, label="wording preference"),
            e(14, "web", 5_000, 4, 2, label="cache docs"),
            e(15, "decision", 850, 4, label="cache layout"),
            e(16, "probe", 2_500, 2, 1, label="pricing sim"),
            e(17, "decision", 650, 2, label="threshold"),
            e(18, "web", 4_500, 3, 1, stale=1_000, label="lsp docs"),
            e(19, "decision", 700, 2, label="lsp bet"),
            e(20, "user", 260, 1, label="scope hold"),
            e(21, "read", 7_500, 5, 3, label="more source"),
            e(22, "decision", 800, 3, label="no bash"),
            e(23, "probe", 3_000, 2, 1, label="sim run"),
            e(24, "validator_pass", 2_000, stale=2_000, label="check pass"),
            e(25, "decision", 650, 3, label="report update"),
            e(26, "web", 5_000, 4, 2, label="subagent docs"),
            e(27, "decision", 700, 2, label="subagent typed patch"),
            e(28, "user", 420, 2, prefs=1, label="pushback"),
            e(29, "probe", 3_500, 2, 1, stale=1_000, label="new sim"),
            e(30, "decision", 900, 4, label="revised conclusion"),
            e(31, "read", 5_500, 4, 2, label="soul source"),
            e(32, "decision", 750, 3, label="soul cache"),
            e(33, "web", 4_000, 3, 1, label="provider refresh"),
            e(34, "probe", 2_800, 2, 1, label="cache sim"),
            e(35, "decision", 900, 4, label="tail runtime"),
            e(36, "user", 220, 1, label="next"),
            e(37, "probe", 3_200, 2, 1, label="projection sim"),
            e(38, "decision", 750, 3, label="projection"),
            e(39, "validator_pass", 1_800, stale=1_800, label="check"),
            e(40, "assistant", 650, label="handoff"),
        ]
    ))

    mixed_events: list[Event] = [e(1, "user", 600, 4, prefs=1, label="long task")]
    for turn in range(2, 81):
        if turn % 13 == 0:
            mixed_events.append(e(turn, "user", 300, 2, prefs=1 if turn in {13, 39, 65} else 0, label="correction"))
        if turn % 7 == 0:
            mixed_events.append(e(turn, "validator_fail", 7_500, 4, 3, stale=2_500, label="failure"))
        elif turn % 11 == 0:
            mixed_events.append(e(turn, "validator_pass", 5_000, stale=5_000, label="pass"))
        elif turn % 5 == 0:
            mixed_events.append(e(turn, "read", 6_000, 5, 3, label="source read"))
        elif turn % 3 == 0:
            mixed_events.append(e(turn, "search", 3_500, 3, 1, stale=1_000, label="search"))
        elif turn % 4 == 0:
            mixed_events.append(e(turn, "probe", 2_600, 2, 1, stale=800, label="probe"))
        else:
            mixed_events.append(e(turn, "decision", 650, 2, label="decision"))
    long_mixed = Session("long_mixed_80", 80, tuple(mixed_events))

    return [small_edit, broad_refactor, debug_loop, research_design, long_mixed]


def update_state(state: ProjectionState, event: Event, strategy: Strategy) -> None:
    state.summary_rewrite = False
    state.raw_tokens += event.tokens
    state.raw_buffer_tokens += event.tokens
    state.critical_facts += event.critical_facts
    state.exact_facts += event.exact_facts
    state.preferences += event.preference_facts
    state.stale_risk_tokens += event.stale_risk_tokens

    if event.kind == "user":
        state.user_turns += 1
        if strategy.classifier:
            state.classifier_calls += 1
            state.classifier_input_tokens += event.tokens
            state.classifier_output_tokens += 32
    elif event.kind in {"read", "edit"}:
        state.active_file_refs = min(36, state.active_file_refs + max(1, event.exact_facts // 2))
    elif event.kind in {"search", "tree", "web", "probe"}:
        state.active_search_refs = min(24, state.active_search_refs + 1)
    elif event.kind == "validator_fail":
        state.active_failure_refs = min(8, state.active_failure_refs + 1)
    elif event.kind == "validator_pass":
        state.active_failure_refs = max(0, state.active_failure_refs - 2)
    elif event.kind == "decision":
        state.decisions = min(60, state.decisions + max(1, event.critical_facts))

    if strategy.hidden_refs:
        state.hidden_bytes += event.tokens * CHARS_PER_TOKEN

    if strategy.model_compaction and (state.raw_buffer_tokens >= 18_000 or event.turn % 6 == 0):
        state.compaction_calls += 1
        state.compaction_input_tokens += state.summary_tokens + state.raw_buffer_tokens
        new_summary = min(14_000, 600 + state.critical_facts * 45 + state.preferences * 60 + state.active_file_refs * 35 + state.active_failure_refs * 120)
        state.compaction_output_tokens += new_summary
        state.summary_tokens = new_summary
        state.raw_buffer_tokens = min(2_000, state.raw_buffer_tokens // 8)
        state.summary_rewrite = True


def mrc_visible_tokens(state: ProjectionState) -> int:
    return min(16_000, 520 + state.critical_facts * 22 + state.active_file_refs * 38 + state.active_search_refs * 18 + state.active_failure_refs * 125 + state.preferences * 45 + min(700, state.user_turns * 50))


def visible_tokens(state: ProjectionState, strategy: Strategy) -> int:
    if strategy.name == "raw_retained_transcript":
        return state.raw_tokens
    if strategy.name == "adaptive_raw_then_mrc":
        if state.raw_tokens <= ADAPTIVE_RAW_THRESHOLD:
            return state.raw_tokens
        return mrc_visible_tokens(state)
    if strategy.name == "rolling_model_summary":
        return state.summary_tokens + state.raw_buffer_tokens
    if strategy.name == "vcc_source_view":
        return min(32_000, 900 + state.critical_facts * 38 + state.exact_facts * 12 + state.active_file_refs * 140 + state.active_search_refs * 70 + state.active_failure_refs * 170 + state.preferences * 55 + min(1_200, state.user_turns * 90))
    if strategy.name == "pi_vcc_sections":
        return min(22_000, 700 + state.critical_facts * 30 + state.active_file_refs * 90 + state.active_search_refs * 45 + state.active_failure_refs * 145 + state.preferences * 60 + min(1_000, state.user_turns * 80))
    if strategy.name == "pi_mrc_keep_ref_drop":
        return mrc_visible_tokens(state)
    if strategy.name == "hybrid_sections_prompt_classifier":
        return min(23_000, 780 + state.critical_facts * 28 + state.active_file_refs * 85 + state.active_search_refs * 38 + state.active_failure_refs * 140 + state.preferences * 75 + min(1_100, state.user_turns * 85))
    raise ValueError(strategy.name)


def cache_for_turn(strategy: Strategy, visible: int, previous_visible: int, rewrite: bool, raw_tokens: int) -> tuple[int, int]:
    if visible <= 0:
        return 0, 0
    if strategy.name == "raw_retained_transcript":
        cached = min(previous_visible, visible)
        return cached, visible - cached
    if strategy.name == "adaptive_raw_then_mrc":
        if raw_tokens <= ADAPTIVE_RAW_THRESHOLD:
            cached = min(previous_visible, visible)
            return cached, visible - cached
        if previous_visible > visible * 2:
            return 0, visible
        stable = int(visible * strategy.stable_cache_share)
        previous_stable = int(previous_visible * strategy.stable_cache_share)
        cached = min(stable, previous_stable)
        return cached, visible - cached
    if strategy.name == "rolling_model_summary":
        if rewrite:
            return 0, visible
        cached = min(previous_visible, visible)
        return cached, visible - cached
    stable = int(visible * strategy.stable_cache_share)
    previous_stable = int(previous_visible * strategy.stable_cache_share)
    cached = min(stable, previous_stable)
    return cached, visible - cached


def main_turn_cost(cached: int, uncached: int) -> float:
    return cached / 1_000_000 * MAIN_CACHED_PER_MTOK + uncached / 1_000_000 * MAIN_INPUT_PER_MTOK


def output_cost(turns: int) -> float:
    return turns * OUTPUT_TOKENS_PER_TURN / 1_000_000 * MAIN_OUTPUT_PER_MTOK


def compaction_cost(state: ProjectionState) -> float:
    return (
        state.compaction_input_tokens / 1_000_000 * SUMMARY_INPUT_PER_MTOK
        + state.compaction_output_tokens / 1_000_000 * SUMMARY_OUTPUT_PER_MTOK
        + state.classifier_input_tokens / 1_000_000 * CLASSIFIER_INPUT_PER_MTOK
        + state.classifier_output_tokens / 1_000_000 * CLASSIFIER_OUTPUT_PER_MTOK
    )


def retention_metrics(session: Session, strategy: Strategy, state: ProjectionState, peak_visible: int, visible_cumulative: int) -> tuple[float, float, float, float, float]:
    attention_penalty = max(0.0, (peak_visible - 80_000) / 160_000)
    context_limit_penalty = 0.25 if peak_visible > 180_000 else 0.0
    if strategy.name == "raw_retained_transcript":
        critical = max(0.55, strategy.critical_base - attention_penalty * 0.35 - context_limit_penalty)
        exact = max(0.50, strategy.exact_base - attention_penalty * 0.30 - context_limit_penalty)
    elif strategy.name == "adaptive_raw_then_mrc" and state.raw_tokens <= ADAPTIVE_RAW_THRESHOLD:
        critical = 0.99
        exact = 0.97
    else:
        density_penalty = max(0.0, (state.critical_facts - 160) / 900)
        critical = max(0.60, strategy.critical_base - density_penalty * 0.08)
        exact = max(0.35, strategy.exact_base - density_penalty * 0.06)

    false_pref = min(0.30, strategy.false_preference_rate * max(1, state.preferences))
    stale_visible = state.stale_risk_tokens * strategy.stale_visibility_factor
    stale_share = min(1.0, stale_visible / max(1, visible_cumulative))
    fact_miss = (1 - critical) * min(1.0, state.critical_facts / 120)
    exact_miss = (1 - exact) * min(1.0, state.exact_facts / 80)
    retry = min(session.turns * 0.35, session.turns * (fact_miss * 0.18 + exact_miss * 0.12 + stale_share * 0.60 + false_pref * 0.08))
    return round(critical, 4), round(exact, 4), round(false_pref, 4), round(stale_share, 5), round(retry, 3)


def simulate_session_strategy(session: Session, strategy: Strategy) -> tuple[list[TurnRow], SummaryRow]:
    events_by_turn: dict[int, list[Event]] = {}
    for event in session.events:
        events_by_turn.setdefault(event.turn, []).append(event)

    state = ProjectionState()
    turn_rows: list[TurnRow] = []
    previous_visible = 0
    visible_values: list[int] = []
    cached_total = 0
    uncached_total = 0
    main_dollars = 0.0

    for turn in range(1, session.turns + 1):
        compaction_before = state.compaction_calls
        classifier_before = state.classifier_calls
        rewrote = False
        for event in events_by_turn.get(turn, []):
            update_state(state, event, strategy)
            rewrote = rewrote or state.summary_rewrite

        visible = visible_tokens(state, strategy)
        cached, uncached = cache_for_turn(strategy, visible, previous_visible, rewrote, state.raw_tokens)
        dollars = main_turn_cost(cached, uncached)
        main_dollars += dollars
        cached_total += cached
        uncached_total += uncached
        visible_values.append(visible)
        turn_rows.append(TurnRow(
            session=session.name,
            strategy=strategy.name,
            turn=turn,
            visible_tokens=visible,
            cached_read_tokens=cached,
            uncached_tokens=uncached,
            compaction_call=state.compaction_calls - compaction_before,
            classifier_call=state.classifier_calls - classifier_before,
            hidden_bytes=state.hidden_bytes,
            dollars=round(dollars, 6),
        ))
        previous_visible = visible

    visible_cumulative = sum(visible_values)
    peak_visible = max(visible_values) if visible_values else 0
    end_visible = visible_values[-1] if visible_values else 0
    critical, exact, false_pref, stale_share, retry_turns = retention_metrics(session, strategy, state, peak_visible, visible_cumulative)
    dollars_before_retry = main_dollars + output_cost(session.turns) + compaction_cost(state)
    avg_turn_cost = dollars_before_retry / max(1, session.turns)
    retry_dollars = retry_turns * avg_turn_cost
    summary = SummaryRow(
        session=session.name,
        strategy=strategy.name,
        turns=session.turns,
        visible_cumulative_tokens=visible_cumulative,
        visible_peak_tokens=peak_visible,
        visible_end_tokens=end_visible,
        cached_read_tokens=cached_total,
        uncached_tokens=uncached_total,
        cache_read_share=round(cached_total / max(1, visible_cumulative), 4),
        hidden_bytes=state.hidden_bytes,
        compaction_calls=state.compaction_calls,
        compaction_input_tokens=state.compaction_input_tokens,
        compaction_output_tokens=state.compaction_output_tokens,
        classifier_calls=state.classifier_calls,
        classifier_input_tokens=state.classifier_input_tokens,
        classifier_output_tokens=state.classifier_output_tokens,
        critical_fact_recall=critical,
        exact_recall_success=exact,
        false_preference_risk=false_pref,
        stale_visible_share=stale_share,
        expected_retry_turns=retry_turns,
        dollars_before_retry=round(dollars_before_retry, 6),
        retry_dollars=round(retry_dollars, 6),
        dollars=round(dollars_before_retry + retry_dollars, 6),
        winner="",
        quality_winner="",
    )
    return turn_rows, summary


def simulate() -> tuple[list[TurnRow], list[SummaryRow]]:
    turn_rows: list[TurnRow] = []
    summaries: list[SummaryRow] = []
    for session in build_sessions():
        session_summaries: list[SummaryRow] = []
        for strategy in STRATEGIES:
            turns, summary = simulate_session_strategy(session, strategy)
            turn_rows.extend(turns)
            session_summaries.append(summary)
        best = min(row.dollars for row in session_summaries)
        qualified = [row for row in session_summaries if row.critical_fact_recall >= 0.95 and row.exact_recall_success >= 0.90]
        quality_best = min((row.dollars for row in qualified), default=best)
        for row in session_summaries:
            row.winner = "winner" if row.dollars == best else ""
            row.quality_winner = "quality_winner" if row.dollars == quality_best and row in qualified else ""
        summaries.extend(session_summaries)
    return turn_rows, summaries


def write_csv(path: Path, rows: list[SummaryRow]) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def write_turn_csv(path: Path, rows: list[TurnRow]) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def rows_for(summaries: list[SummaryRow], session: str) -> list[SummaryRow]:
    return sorted([row for row in summaries if row.session == session], key=lambda row: row.dollars)


def turn_rows_for(turn_rows: list[TurnRow], session: str, strategy: str) -> list[TurnRow]:
    return [row for row in turn_rows if row.session == session and row.strategy == strategy]


def write_markdown(path: Path, turn_rows: list[TurnRow], summaries: list[SummaryRow]) -> None:
    wins: dict[str, int] = {}
    quality_wins: dict[str, int] = {}
    for row in summaries:
        if row.winner:
            wins[row.strategy] = wins.get(row.strategy, 0) + 1
        if row.quality_winner:
            quality_wins[row.strategy] = quality_wins.get(row.strategy, 0) + 1

    lines = [
        "# Projection/compaction simulation",
        "",
        "Question: does deterministic state -> compiled context view beat raw transcript and model summaries?",
        "",
        "This is a turn-by-turn simulation over five agentic sessions. It models visible context rent, prompt-cache reuse, hidden evidence, model compaction calls, exact recall, stale-evidence exposure, and retry risk. Recall probabilities are explicit assumptions; fixture benchmarks still have to measure them.",
        "",
        "## Strategy shapes",
        "",
        "| strategy | shape |",
        "|---|---|",
    ]
    for strategy in STRATEGIES:
        lines.append(f"| {strategy.name} | {strategy.description} |")

    lines += [
        "",
        "## Cost assumptions",
        "",
        "| item | value |",
        "|---|---:|",
        f"| main input | ${MAIN_INPUT_PER_MTOK:.2f}/Mtok |",
        f"| cached input | ${MAIN_CACHED_PER_MTOK:.2f}/Mtok |",
        f"| main output | ${MAIN_OUTPUT_PER_MTOK:.2f}/Mtok |",
        f"| summary input | ${SUMMARY_INPUT_PER_MTOK:.2f}/Mtok |",
        f"| summary output | ${SUMMARY_OUTPUT_PER_MTOK:.2f}/Mtok |",
        f"| classifier input | ${CLASSIFIER_INPUT_PER_MTOK:.2f}/Mtok |",
        f"| classifier output | ${CLASSIFIER_OUTPUT_PER_MTOK:.2f}/Mtok |",
        f"| output tokens/turn | {OUTPUT_TOKENS_PER_TURN:,} |",
        "",
        "Cache model: raw transcript is append-only and cache-friendly; model summaries rewrite prefix on compaction turns; deterministic projections have only a stable section share cached and pay the dynamic view uncached each turn.",
        "",
        "## Cost-only winner counts",
        "",
        "| strategy | wins |",
        "|---|---:|",
    ]
    for strategy, count in sorted(wins.items(), key=lambda item: item[1], reverse=True):
        lines.append(f"| {strategy} | {count} |")

    lines += [
        "",
        "## Quality-gated winner counts",
        "",
        "Requires at least 95% critical-fact recall and 90% exact recall. This is the sanity brake against choosing a tiny view that looks cheap but under-remembers intent.",
        "",
        "| strategy | wins |",
        "|---|---:|",
    ]
    for strategy, count in sorted(quality_wins.items(), key=lambda item: item[1], reverse=True):
        lines.append(f"| {strategy} | {count} |")

    lines += [
        "",
        "## Session winners",
        "",
        "| session | cost winner | quality-gated winner | cost $ | quality $ | cost recall | quality recall | quality exact |",
        "|---|---|---|---:|---:|---:|---:|---:|",
    ]
    for session in [s.name for s in build_sessions()]:
        winner = [row for row in summaries if row.session == session and row.winner][0]
        quality = [row for row in summaries if row.session == session and row.quality_winner][0]
        lines.append(f"| {session} | {winner.strategy} | {quality.strategy} | ${winner.dollars:.4f} | ${quality.dollars:.4f} | {winner.critical_fact_recall:.1%} | {quality.critical_fact_recall:.1%} | {quality.exact_recall_success:.1%} |")

    lines += [
        "",
        "## Long mixed 80-turn session",
        "",
        "| strategy | dollars | peak visible | cumulative visible | cached % | hidden bytes | compactions | recall | exact | stale share | retry turns |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows_for(summaries, "long_mixed_80"):
        lines.append(f"| {row.strategy} | ${row.dollars:.4f} | {row.visible_peak_tokens:,} | {row.visible_cumulative_tokens:,} | {row.cache_read_share:.1%} | {row.hidden_bytes:,} | {row.compaction_calls} | {row.critical_fact_recall:.1%} | {row.exact_recall_success:.1%} | {row.stale_visible_share:.2%} | {row.expected_retry_turns:.2f} |")

    lines += [
        "",
        "## Broad refactor 18-turn session",
        "",
        "| strategy | dollars | end visible | uncached tokens | compaction input | classifier input | recall | exact | false pref risk | retry turns |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows_for(summaries, "broad_refactor_18"):
        lines.append(f"| {row.strategy} | ${row.dollars:.4f} | {row.visible_end_tokens:,} | {row.uncached_tokens:,} | {row.compaction_input_tokens:,} | {row.classifier_input_tokens:,} | {row.critical_fact_recall:.1%} | {row.exact_recall_success:.1%} | {row.false_preference_risk:.1%} | {row.expected_retry_turns:.2f} |")

    lines += [
        "",
        "## Turn trace: long mixed 80, raw vs hybrid tail",
        "",
        "Last ten turns only.",
        "",
        "| turn | raw visible | raw uncached | hybrid visible | hybrid uncached | hybrid classifier |",
        "|---:|---:|---:|---:|---:|---:|",
    ]
    raw_turns = {row.turn: row for row in turn_rows_for(turn_rows, "long_mixed_80", "raw_retained_transcript")}
    hybrid_turns = {row.turn: row for row in turn_rows_for(turn_rows, "long_mixed_80", "hybrid_sections_prompt_classifier")}
    for turn in range(71, 81):
        raw = raw_turns[turn]
        hybrid = hybrid_turns[turn]
        lines.append(f"| {turn} | {raw.visible_tokens:,} | {raw.uncached_tokens:,} | {hybrid.visible_tokens:,} | {hybrid.uncached_tokens:,} | {hybrid.classifier_call} |")

    lines += [
        "",
        "## Takeaways",
        "",
        "- Raw transcript is cache-friendly but eventually loses on stale evidence, attention, and context-window pressure.",
        "- Rolling model summaries look cheap but are bad at exact recall and preference/correction fidelity. Use only as fallback.",
        "- Cost-only winner is pi-mrc in this sim, but that is not enough. With a 95%/90% recall gate, hybrid/VCC-style views become the safer default.",
        "- Deterministic VCC/pi-vcc projections win the normal lane: no model compaction calls, compact visible state, exact handles retained hidden.",
        "- pi-mrc KEEP/REF/DROP is the cost floor when lookup tools are reliable; it needs good UX for expanding refs before reasoning from hidden evidence.",
        "- Prompt-intake classifier is cheap enough to test. It mainly buys goal/preference/correction recall, not file exactness.",
        "- Projection output must remain prompt-cache-aware: stable kernel/pinned facts cached, volatile current-state capsule late and small.",
    ]
    path.write_text("\n".join(lines))


def write_json(path: Path, turn_rows: list[TurnRow], summaries: list[SummaryRow]) -> None:
    path.write_text(json.dumps({
        "assumptions": {
            "main_input_per_mtok": MAIN_INPUT_PER_MTOK,
            "main_cached_per_mtok": MAIN_CACHED_PER_MTOK,
            "main_output_per_mtok": MAIN_OUTPUT_PER_MTOK,
            "summary_input_per_mtok": SUMMARY_INPUT_PER_MTOK,
            "summary_output_per_mtok": SUMMARY_OUTPUT_PER_MTOK,
            "classifier_input_per_mtok": CLASSIFIER_INPUT_PER_MTOK,
            "classifier_output_per_mtok": CLASSIFIER_OUTPUT_PER_MTOK,
            "output_tokens_per_turn": OUTPUT_TOKENS_PER_TURN,
        },
        "strategies": [asdict(strategy) for strategy in STRATEGIES],
        "summaries": [asdict(row) for row in summaries],
        "representative_turns": [
            asdict(row) for row in turn_rows
            if row.session == "long_mixed_80" and row.strategy in {"raw_retained_transcript", "hybrid_sections_prompt_classifier"}
        ],
    }, indent=2))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>Projection/compaction simulation</title>
  <script src=\"https://cdn.tailwindcss.com\"></script>
</head>
<body class=\"bg-zinc-950 text-zinc-100\">
  <main class=\"mx-auto max-w-6xl p-8\">
    <pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre>
  </main>
</body>
</html>
""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    turn_rows, summaries = simulate()
    md_path = REPORT_DIR / "projection-compaction-sim.md"
    json_path = REPORT_DIR / "projection-compaction-sim.json"
    csv_path = REPORT_DIR / "projection-compaction-sim.csv"
    turn_csv_path = REPORT_DIR / "projection-compaction-sim-turns.csv"
    html_path = REPORT_DIR / "projection-compaction-sim.html"
    write_markdown(md_path, turn_rows, summaries)
    write_json(json_path, turn_rows, summaries)
    write_csv(csv_path, summaries)
    write_turn_csv(turn_csv_path, turn_rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, turn_csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
