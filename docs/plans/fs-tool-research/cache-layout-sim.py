#!/usr/bin/env python3
"""Provider-aware prompt-cache session simulation."""

from __future__ import annotations

import csv
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/plans/fs-tool-research/reports")

TOOLS_ALL = 12_000
TOOLS_MODE = 4_000
TOOLS_DISPATCHER = 1_000
SYSTEM = 6_000
PROJECT_RULES = 4_000
USER = 800
ASSISTANT = 650
OUTPUT = 650
RUNTIME = 1_000
CONTEXT_SIZES = [20_000, 80_000, 160_000]


@dataclass(frozen=True)
class Segment:
    name: str
    identity: str
    tokens: int


@dataclass(frozen=True)
class Provider:
    name: str
    kind: str
    input_per_mtok: float
    cached_per_mtok: float
    write_per_mtok: float
    output_per_mtok: float
    min_cache_tokens: int
    round_increment: int = 0


@dataclass(frozen=True)
class Layout:
    name: str
    tool_shape: str
    runtime_position: str
    volatile_context: bool = False
    retry_rate: float = 0.0


@dataclass(frozen=True)
class Session:
    name: str
    turns: int
    posture_switch_turns: tuple[int, ...]
    tool_switch_turns: tuple[int, ...]
    context_update_turns: tuple[int, ...]


@dataclass
class TurnRow:
    provider: str
    session: str
    layout: str
    context_tokens: int
    turn: int
    event: str
    input_tokens: int
    cached_read_tokens: int
    cache_write_tokens: int
    uncached_tokens: int
    output_tokens: int
    dollars: float


@dataclass
class SummaryRow:
    provider: str
    session: str
    layout: str
    context_tokens: int
    turns: int
    input_tokens: int
    cached_read_tokens: int
    cache_write_tokens: int
    uncached_tokens: int
    output_tokens: int
    cache_miss_turns: int
    expected_retry_turns: float
    dollars_before_retry: float
    retry_dollars: float
    dollars: float
    cache_read_share: float
    winner: str


PROVIDERS = [
    Provider("anthropic_explicit_5m", "anthropic", 3.0, 0.30, 3.75, 15.0, 1_024),
    Provider("openai_auto_lcp", "lcp", 3.0, 0.30, 0.0, 12.0, 1_024, 128),
    Provider("gemini_explicit_static", "gemini_explicit", 1.25, 0.125, 1.25, 10.0, 2_048),
    Provider("xai_auto_message_prefix", "lcp", 3.0, 0.30, 0.0, 15.0, 0),
]

LAYOUTS = [
    Layout("stable_tools_runtime_after_user", "all", "after_user"),
    Layout("stable_tools_runtime_before_user", "all", "before_user"),
    Layout("soul_system_rewrite", "all", "system"),
    Layout("mode_specific_tools_runtime_after_user", "mode", "after_user"),
    Layout("volatile_context_runtime_after_user", "all", "after_user", volatile_context=True),
    Layout("generic_dispatcher_runtime_after_user", "dispatcher", "after_user", retry_rate=0.06),
]

SESSIONS = [
    Session("steady_12", 12, (), (), ()),
    Session("posture_heavy_12", 12, (3, 6, 9), (), ()),
    Session("tool_mode_12", 12, (), (5, 9), ()),
    Session("mixed_agent_12", 12, (3, 6, 9), (5, 9), (4, 8)),
    Session("long_mixed_40", 40, (6, 12, 18, 24, 30, 36), (10, 20, 30), (15, 30)),
]


def version(turn: int, switch_turns: tuple[int, ...]) -> int:
    return 1 + sum(1 for switch in switch_turns if switch <= turn)


def event_label(turn: int, session: Session) -> str:
    events = []
    if turn in session.posture_switch_turns:
        events.append("posture")
    if turn in session.tool_switch_turns:
        events.append("tool")
    if turn in session.context_update_turns:
        events.append("context")
    return "+".join(events) or ""


def tool_segment(layout: Layout, turn: int, session: Session) -> Segment:
    if layout.tool_shape == "mode":
        v = version(turn, session.tool_switch_turns)
        return Segment("tools", f"tools:mode:{v}", TOOLS_MODE)
    if layout.tool_shape == "dispatcher":
        return Segment("tools", "tools:dispatcher:1", TOOLS_DISPATCHER)
    return Segment("tools", "tools:all:1", TOOLS_ALL)


def system_segment(layout: Layout, turn: int, session: Session) -> Segment:
    if layout.runtime_position == "system":
        v = version(turn, session.posture_switch_turns)
        return Segment("system", f"system:soul-posture:{v}", SYSTEM + PROJECT_RULES + RUNTIME)
    return Segment("system", "system:stable", SYSTEM + PROJECT_RULES)


def context_segment(layout: Layout, turn: int, session: Session, context_tokens: int) -> Segment:
    if layout.volatile_context:
        return Segment("context", f"context:volatile-turn:{turn}", context_tokens)
    v = version(turn, session.context_update_turns)
    return Segment("context", f"context:{v}", context_tokens)


def transcript_segments(turn: int) -> list[Segment]:
    segments: list[Segment] = []
    for i in range(1, turn):
        segments.append(Segment("user", f"user:{i}", USER))
        segments.append(Segment("assistant", f"assistant:{i}", ASSISTANT))
    return segments


def prompt_segments(layout: Layout, turn: int, session: Session, context_tokens: int) -> list[Segment]:
    segments = [
        tool_segment(layout, turn, session),
        system_segment(layout, turn, session),
        context_segment(layout, turn, session, context_tokens),
        *transcript_segments(turn),
    ]
    current_user = Segment("user", f"user:{turn}", USER)
    runtime = Segment("runtime", f"runtime:{turn}", RUNTIME)
    if layout.runtime_position == "before_user":
        segments.extend([runtime, current_user])
    elif layout.runtime_position == "after_user":
        segments.extend([current_user, runtime])
    else:
        segments.append(current_user)
    return segments


def anthropic_cacheable_prefix(segments: list[Segment]) -> list[Segment]:
    prefix: list[Segment] = []
    for segment in segments:
        if segment.name == "runtime":
            break
        prefix.append(segment)
    return prefix


def token_sum(segments: list[Segment]) -> int:
    return sum(segment.tokens for segment in segments)


def lcp_tokens(left: list[Segment], right: list[Segment]) -> int:
    total = 0
    for a, b in zip(left, right):
        if a.identity != b.identity or a.tokens != b.tokens:
            break
        total += a.tokens
    return total


def max_cached_tokens(current: list[Segment], cache: list[list[Segment]], provider: Provider) -> int:
    cached = max((lcp_tokens(current, old) for old in cache), default=0)
    if cached < provider.min_cache_tokens:
        return 0
    if provider.round_increment:
        cached = (cached // provider.round_increment) * provider.round_increment
    return cached


def cost(provider: Provider, uncached: int, cached_read: int, cache_write: int, output: int) -> float:
    return round(
        uncached / 1_000_000 * provider.input_per_mtok
        + cached_read / 1_000_000 * provider.cached_per_mtok
        + cache_write / 1_000_000 * provider.write_per_mtok
        + output / 1_000_000 * provider.output_per_mtok,
        6,
    )


def simulate_turns(provider: Provider, session: Session, layout: Layout, context_tokens: int) -> list[TurnRow]:
    rows: list[TurnRow] = []
    prefix_cache: list[list[Segment]] = []
    gemini_static_cache: set[tuple[str, ...]] = set()

    for turn in range(1, session.turns + 1):
        segments = prompt_segments(layout, turn, session, context_tokens)
        total_input = token_sum(segments)
        output = OUTPUT
        event = event_label(turn, session)

        if provider.kind == "anthropic":
            cacheable = anthropic_cacheable_prefix(segments)
            cacheable_tokens = token_sum(cacheable)
            cached_read = max_cached_tokens(cacheable, prefix_cache, provider)
            cache_write = max(0, cacheable_tokens - cached_read)
            uncached = total_input - cacheable_tokens
            dollars = cost(provider, uncached, cached_read, cache_write, output)
            prefix_cache.append(cacheable)
        elif provider.kind == "gemini_explicit":
            static = segments[:3]
            static_tokens = token_sum(static)
            key = tuple(segment.identity for segment in static)
            if key in gemini_static_cache and static_tokens >= provider.min_cache_tokens:
                cached_read = static_tokens
                cache_write = 0
            else:
                cached_read = 0
                cache_write = static_tokens
                gemini_static_cache.add(key)
            uncached = total_input - static_tokens
            dollars = cost(provider, uncached, cached_read, cache_write, output)
        else:
            cached_read = max_cached_tokens(segments, prefix_cache, provider)
            cache_write = 0
            uncached = total_input - cached_read
            dollars = cost(provider, uncached, cached_read, cache_write, output)
            prefix_cache.append(segments)

        rows.append(TurnRow(
            provider=provider.name,
            session=session.name,
            layout=layout.name,
            context_tokens=context_tokens,
            turn=turn,
            event=event,
            input_tokens=total_input,
            cached_read_tokens=cached_read,
            cache_write_tokens=cache_write,
            uncached_tokens=uncached,
            output_tokens=output,
            dollars=dollars,
        ))
    return rows


def summarize(turns: list[TurnRow], layout: Layout) -> SummaryRow:
    input_tokens = sum(row.input_tokens for row in turns)
    cached = sum(row.cached_read_tokens for row in turns)
    writes = sum(row.cache_write_tokens for row in turns)
    uncached = sum(row.uncached_tokens for row in turns)
    output = sum(row.output_tokens for row in turns)
    base_dollars = round(sum(row.dollars for row in turns), 6)
    retry_turns = round(len(turns) * layout.retry_rate, 3)
    retry_dollars = round(base_dollars * layout.retry_rate, 6)
    dollars = round(base_dollars + retry_dollars, 6)
    return SummaryRow(
        provider=turns[0].provider,
        session=turns[0].session,
        layout=turns[0].layout,
        context_tokens=turns[0].context_tokens,
        turns=len(turns),
        input_tokens=input_tokens,
        cached_read_tokens=cached,
        cache_write_tokens=writes,
        uncached_tokens=uncached,
        output_tokens=output,
        cache_miss_turns=sum(1 for row in turns if row.cached_read_tokens == 0),
        expected_retry_turns=retry_turns,
        dollars_before_retry=base_dollars,
        retry_dollars=retry_dollars,
        dollars=dollars,
        cache_read_share=round(cached / input_tokens, 4) if input_tokens else 0,
        winner="",
    )


def simulate() -> tuple[list[TurnRow], list[SummaryRow]]:
    turn_rows: list[TurnRow] = []
    summaries: list[SummaryRow] = []
    for provider in PROVIDERS:
        for session in SESSIONS:
            for context_tokens in CONTEXT_SIZES:
                scenario_summaries: list[SummaryRow] = []
                for layout in LAYOUTS:
                    turns = simulate_turns(provider, session, layout, context_tokens)
                    turn_rows.extend(turns)
                    scenario_summaries.append(summarize(turns, layout))
                best = min(row.dollars for row in scenario_summaries)
                for row in scenario_summaries:
                    row.winner = "winner" if row.dollars == best else ""
                summaries.extend(scenario_summaries)
    return turn_rows, summaries


def write_csv(rows: list[SummaryRow], path: Path) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def write_turn_csv(rows: list[TurnRow], path: Path) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def subset(rows: list[SummaryRow], **filters: object) -> list[SummaryRow]:
    out = rows
    for key, value in filters.items():
        out = [row for row in out if getattr(row, key) == value]
    return sorted(out, key=lambda row: row.dollars)


def turn_subset(rows: list[TurnRow], **filters: object) -> list[TurnRow]:
    out = rows
    for key, value in filters.items():
        out = [row for row in out if getattr(row, key) == value]
    return sorted(out, key=lambda row: row.turn)


def write_markdown(turn_rows: list[TurnRow], summaries: list[SummaryRow], path: Path) -> None:
    winner_counts: dict[str, int] = {}
    for row in summaries:
        if row.winner:
            winner_counts[row.layout] = winner_counts.get(row.layout, 0) + 1

    lines = [
        "# Cache-layout simulation",
        "",
        "Question: what actually busts prompt cache in agentic sessions, turn by turn?",
        "",
        "Inputs come from `cache-layout-research.md`. Rates are illustrative; provider cache semantics are the important part.",
        "",
        "## Simulated layouts",
        "",
        "| layout | shape |",
        "|---|---|",
        "| stable_tools_runtime_after_user | stable tools/system/context, append transcript, latest user, volatile runtime at absolute tail |",
        "| stable_tools_runtime_before_user | same, but volatile runtime before latest user; poisons next-turn prefix |",
        "| soul_system_rewrite | posture/runtime in system prompt; system identity changes on posture switch |",
        "| mode_specific_tools_runtime_after_user | smaller tool schema; each tool switch is modeled as a new unseen schema |",
        "| volatile_context_runtime_after_user | compiled context identity changes every turn before transcript |",
        "| generic_dispatcher_runtime_after_user | tiny stable dispatcher schema, 6% illustrative retry penalty |",
        "",
        "## Provider models",
        "",
        "| provider | modeled cache behavior |",
        "|---|---|",
        "| anthropic_explicit_5m | tools->system->messages; breakpoint before volatile runtime; cache writes 1.25x, reads 0.1x |",
        "| openai_auto_lcp | automatic longest common prefix, >=1024 tokens, rounded to 128-token chunks |",
        "| gemini_explicit_static | immutable cachedContent for tools+system+context; dynamic transcript/runtime outside cache |",
        "| xai_auto_message_prefix | exact append-only prefix from start of messages/request, sticky routing assumed |",
        "",
        "## Winner counts",
        "",
        "| layout | wins |",
        "|---|---:|",
    ]
    for layout, count in sorted(winner_counts.items(), key=lambda item: item[1], reverse=True):
        lines.append(f"| {layout} | {count:,} |")

    lines += [
        "",
        "## Representative mixed 12-turn session, 80k context",
        "",
        "Events: posture switches on turns 3/6/9, tool switches on 5/9, context updates on 4/8.",
        "",
        "| provider | layout | miss turns | cache read % | write tokens | uncached tokens | retry turns | dollars |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for provider in [p.name for p in PROVIDERS]:
        for row in subset(summaries, provider=provider, session="mixed_agent_12", context_tokens=80_000):
            lines.append(f"| {provider} | {row.layout} | {row.cache_miss_turns} | {row.cache_read_share:.1%} | {row.cache_write_tokens:,} | {row.uncached_tokens:,} | {row.expected_retry_turns:.2f} | ${row.dollars:.4f} |")

    lines += [
        "",
        "## Runtime before vs after latest user",
        "",
        "OpenAI-style automatic LCP, mixed 12-turn, 80k context.",
        "",
        "| layout | cached read | uncached | dollars |",
        "|---|---:|---:|---:|",
    ]
    for row in subset(summaries, provider="openai_auto_lcp", session="mixed_agent_12", context_tokens=80_000):
        if row.layout in {"stable_tools_runtime_after_user", "stable_tools_runtime_before_user"}:
            lines.append(f"| {row.layout} | {row.cached_read_tokens:,} | {row.uncached_tokens:,} | ${row.dollars:.4f} |")

    lines += [
        "",
        "## Turn trace: OpenAI-style LCP, mixed session, stable tail runtime",
        "",
        "| turn | event | input | cached | uncached | dollars |",
        "|---:|---|---:|---:|---:|---:|",
    ]
    for row in turn_subset(
        turn_rows,
        provider="openai_auto_lcp",
        session="mixed_agent_12",
        layout="stable_tools_runtime_after_user",
        context_tokens=80_000,
    ):
        lines.append(f"| {row.turn} | {row.event or '-'} | {row.input_tokens:,} | {row.cached_read_tokens:,} | {row.uncached_tokens:,} | ${row.dollars:.4f} |")

    lines += [
        "",
        "## Takeaways",
        "",
        "- Tail runtime after the latest user is better than runtime before the latest user for automatic longest-prefix caches; delta scales with latest-user size.",
        "- Soul-style system rewrite is worst when posture switches happen because system sits before messages.",
        "- Tool schema churn is provider-visible. Mode-specific schemas win surprisingly often here despite conservative new-schema-on-each-switch modeling; repeated known modes would improve them further.",
        "- Volatile compiled context before transcript is cache poison. Context projection must be deterministic and stable except real state changes.",
        "- Gemini explicit caching favors stable static context packs; transcript/runtime remain normal appended input.",
        "- Generic dispatcher is a cache floor, not a product answer. Need behavior/error-rate measurement before considering it.",
    ]
    path.write_text("\n".join(lines))


def write_json(turn_rows: list[TurnRow], summaries: list[SummaryRow], path: Path) -> None:
    representative_turns = [
        asdict(row) for row in turn_rows
        if row.provider == "openai_auto_lcp"
        and row.session == "mixed_agent_12"
        and row.layout == "stable_tools_runtime_after_user"
        and row.context_tokens == 80_000
    ]
    representative_summaries = [
        asdict(row) for row in summaries
        if row.session == "mixed_agent_12" and row.context_tokens == 80_000
    ]
    path.write_text(json.dumps({
        "providers": [asdict(provider) for provider in PROVIDERS],
        "layouts": [asdict(layout) for layout in LAYOUTS],
        "sessions": [asdict(session) for session in SESSIONS],
        "representative_turns": representative_turns,
        "representative_summaries": representative_summaries,
    }, indent=2))


def write_html(markdown_path: Path, html_path: Path) -> None:
    body = markdown_path.read_text().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html_path.write_text(f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>Cache-layout simulation</title>
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
    summary_csv = REPORT_DIR / "cache-layout-sim.csv"
    turn_csv = REPORT_DIR / "cache-layout-sim-turns.csv"
    json_path = REPORT_DIR / "cache-layout-sim.json"
    md_path = REPORT_DIR / "cache-layout-sim.md"
    html_path = REPORT_DIR / "cache-layout-sim.html"
    write_csv(summaries, summary_csv)
    write_turn_csv(turn_rows, turn_csv)
    write_json(turn_rows, summaries, json_path)
    write_markdown(turn_rows, summaries, md_path)
    write_html(md_path, html_path)
    for report in [md_path, json_path, summary_csv, turn_csv, html_path]:
        print(report)


if __name__ == "__main__":
    main()
