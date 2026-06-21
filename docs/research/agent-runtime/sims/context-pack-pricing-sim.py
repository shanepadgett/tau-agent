#!/usr/bin/env python3
"""Compare upfront scoped context packs with iterative discovery loops."""

from __future__ import annotations

import csv
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/context-pack-pricing-sim")
PROFILE_JSON = REPORT_DIR / "repo-size-profile.json"

BASE_CONTEXT_TOKENS = [20_000, 80_000, 160_000]
TARGET_CONTEXT_TOKENS = [15_000, 25_000, 40_000, 80_000]
DISCOVERY_TURNS = [1, 2, 4, 8, 12]
NOISE_MULTIPLIERS = [1.0, 1.1, 1.5, 2.5]
TOOL_NOISE_PER_TURN = [0, 750, 1_500, 3_000]
UPFRONT_IRRELEVANT_MULTIPLIERS = [1.0, 1.25, 1.5, 2.0]
FUTURE_TURNS = [1, 4, 8]
OUTPUT_TOKENS_PER_TURN = 650
UPFRONT_SELECTION_OVERHEAD = 1_200

MODELS = [
    {
        "name": "sonnet-ish",
        "input_per_mtok": 3.0,
        "cached_input_per_mtok": 0.30,
        "output_per_mtok": 15.0,
        "cache_ratio": 0.85,
    },
    {
        "name": "sonnet-poor-cache",
        "input_per_mtok": 3.0,
        "cached_input_per_mtok": 0.30,
        "output_per_mtok": 15.0,
        "cache_ratio": 0.25,
    },
    {
        "name": "opus-ish",
        "input_per_mtok": 15.0,
        "cached_input_per_mtok": 1.50,
        "output_per_mtok": 75.0,
        "cache_ratio": 0.85,
    },
    {
        "name": "cheap-ish",
        "input_per_mtok": 0.50,
        "cached_input_per_mtok": 0.05,
        "output_per_mtok": 2.0,
        "cache_ratio": 0.85,
    },
]


@dataclass
class SimRow:
    repo: str
    model: str
    base_context_tokens: int
    target_context_tokens: int
    future_turns: int
    discovery_turns: int
    noise_multiplier: float
    tool_noise_per_turn: int
    upfront_irrelevant_multiplier: float
    upfront_effective_tokens: int
    iterative_effective_tokens: int
    upfront_dollars: float
    iterative_dollars: float
    winner: str
    savings_dollars: float
    savings_ratio: float
    waste_tokens: int


def effective_input_tokens(input_tokens: int, cache_ratio: float, cached_multiplier: float = 0.1) -> float:
    return input_tokens * ((1 - cache_ratio) + cache_ratio * cached_multiplier)


def dollars(input_tokens: float, output_tokens: float, model: dict[str, float | str]) -> float:
    uncached_rate = float(model["input_per_mtok"])
    output_rate = float(model["output_per_mtok"])
    return (input_tokens / 1_000_000 * uncached_rate) + (output_tokens / 1_000_000 * output_rate)


def repo_labels() -> list[str]:
    if not PROFILE_JSON.exists():
        return ["pi", "codex", "opencode", "tau-agent"]
    data = json.loads(PROFILE_JSON.read_text())
    return [repo["repo"] for repo in data["repos"]]


def simulate() -> list[SimRow]:
    rows: list[SimRow] = []
    for repo in repo_labels():
        for model in MODELS:
            cache_ratio = float(model["cache_ratio"])
            cached_multiplier = float(model["cached_input_per_mtok"]) / float(model["input_per_mtok"])
            for base in BASE_CONTEXT_TOKENS:
                for target in TARGET_CONTEXT_TOKENS:
                    for future in FUTURE_TURNS:
                        for upfront_mult in UPFRONT_IRRELEVANT_MULTIPLIERS:
                            upfront_pack_tokens = round(target * upfront_mult)
                            upfront_visible = base + upfront_pack_tokens + UPFRONT_SELECTION_OVERHEAD
                            upfront_input_effective = effective_input_tokens(upfront_visible, cache_ratio, cached_multiplier)
                            upfront_future_effective = future * effective_input_tokens(base + upfront_pack_tokens, cache_ratio, cached_multiplier)
                            upfront_output = OUTPUT_TOKENS_PER_TURN
                            upfront_effective = round(upfront_input_effective + upfront_future_effective + upfront_output)
                            upfront_cost = dollars(upfront_input_effective + upfront_future_effective, upfront_output, model)

                            for turns in DISCOVERY_TURNS:
                                for noise_mult in NOISE_MULTIPLIERS:
                                    for tool_noise in TOOL_NOISE_PER_TURN:
                                        useful_read_tokens = target
                                        junk_read_tokens = round(target * (noise_mult - 1))
                                        discovery_noise = turns * tool_noise
                                        cumulative_turn_context = 0
                                        for turn in range(1, turns + 1):
                                            fraction_found = turn / turns
                                            visible_so_far = base + round(useful_read_tokens * fraction_found) + round(junk_read_tokens * fraction_found) + turn * tool_noise
                                            cumulative_turn_context += effective_input_tokens(visible_so_far, cache_ratio, cached_multiplier)
                                        final_context = base + useful_read_tokens + junk_read_tokens + discovery_noise
                                        future_effective = future * effective_input_tokens(final_context, cache_ratio, cached_multiplier)
                                        output = turns * OUTPUT_TOKENS_PER_TURN
                                        iterative_effective = round(cumulative_turn_context + future_effective + output)
                                        iterative_cost = dollars(cumulative_turn_context + future_effective, output, model)
                                        winner = "upfront" if upfront_cost < iterative_cost else "iterative"
                                        savings = iterative_cost - upfront_cost
                                        ratio = iterative_cost / upfront_cost if upfront_cost else 0
                                        rows.append(SimRow(
                                            repo=repo,
                                            model=str(model["name"]),
                                            base_context_tokens=base,
                                            target_context_tokens=target,
                                            future_turns=future,
                                            discovery_turns=turns,
                                            noise_multiplier=noise_mult,
                                            tool_noise_per_turn=tool_noise,
                                            upfront_irrelevant_multiplier=upfront_mult,
                                            upfront_effective_tokens=upfront_effective,
                                            iterative_effective_tokens=iterative_effective,
                                            upfront_dollars=round(upfront_cost, 6),
                                            iterative_dollars=round(iterative_cost, 6),
                                            winner=winner,
                                            savings_dollars=round(savings, 6),
                                            savings_ratio=round(ratio, 3),
                                            waste_tokens=junk_read_tokens + discovery_noise,
                                        ))
    return rows


def write_csv(rows: list[SimRow], path: Path) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def write_markdown(rows: list[SimRow], path: Path) -> None:
    total = len(rows)
    upfront_wins = sum(1 for row in rows if row.winner == "upfront")
    lines = [
        "# Context-pack pricing simulation",
        "",
        "Question: when is upfront scoped context cheaper than iterative grep/read discovery to the same useful context?",
        "",
        "Assumptions are deliberately rough. They are knobs, not truth. This version includes hostile cases: one-turn discovery, zero tool noise, poor cache, and overbroad upfront packs.",
        "",
        f"Rows: {total:,}. Upfront wins: {upfront_wins:,} ({upfront_wins / total:.1%}).",
        "",
        "## Model assumptions",
        "",
        "| model | input $/MTok | cached $/MTok | output $/MTok | cache ratio |",
        "|---|---:|---:|---:|---:|",
    ]
    for model in MODELS:
        lines.append(f"| {model['name']} | {model['input_per_mtok']} | {model['cached_input_per_mtok']} | {model['output_per_mtok']} | {model['cache_ratio']:.0%} |")

    lines += [
        "",
        "## Representative 40k target, 80k base, sonnet-ish",
        "",
        "| future turns | discovery turns | discovery noise | tool noise/turn | upfront overbreadth | upfront $ | iterative $ | winner | iterative/upfront | waste tokens |",
        "|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|",
    ]
    reps = [
        row for row in rows
        if row.model == "sonnet-ish"
        and row.base_context_tokens == 80_000
        and row.target_context_tokens == 40_000
        and row.repo == "pi"
        and row.noise_multiplier in {1.0, 1.5, 2.5}
        and row.tool_noise_per_turn in {0, 1_500}
        and row.upfront_irrelevant_multiplier in {1.0, 1.5, 2.0}
    ]
    for row in reps:
        lines.append(f"| {row.future_turns} | {row.discovery_turns} | {row.noise_multiplier}x | {row.tool_noise_per_turn:,} | {row.upfront_irrelevant_multiplier}x | {row.upfront_dollars:.4f} | {row.iterative_dollars:.4f} | {row.winner} | {row.savings_ratio:.2f}x | {row.waste_tokens:,} |")

    lines += ["", "## Break-even-ish discovery turns", "", "For each target/base/future case, smallest discovery-turn count where upfront wins under realistic noise (`1.5x`, `1,500` tool noise/turn).", "", "| model | base | target | future turns | first upfront win |", "|---|---:|---:|---:|---:|"]
    for model in ["cheap-ish", "sonnet-ish", "opus-ish"]:
        for base in BASE_CONTEXT_TOKENS:
            for target in TARGET_CONTEXT_TOKENS:
                for future in FUTURE_TURNS:
                    subset = [
                        row for row in rows
                        if row.repo == "pi"
                        and row.model == model
                        and row.base_context_tokens == base
                        and row.target_context_tokens == target
                        and row.future_turns == future
                        and row.noise_multiplier == 1.5
                        and row.tool_noise_per_turn == 1_500
                        and row.upfront_irrelevant_multiplier == 1.0
                        and row.winner == "upfront"
                    ]
                    first = min((row.discovery_turns for row in subset), default=0)
                    lines.append(f"| {model} | {base:,} | {target:,} | {future} | {first or 'never'} |")

    lines += [
        "",
        "## Read",
        "",
        "- Clean upfront packs beat wandering quickly because discovery pays model-turn rent before useful work starts.",
        "- Bad upfront packs can lose to one-turn exact discovery. Scope quality matters.",
        "- Equal final useful context is not equal total cost.",
        "- Next sim should use this result to price whole-file reads vs extra turns.",
    ]
    path.write_text("\n".join(lines))


def write_html(markdown_path: Path, html_path: Path) -> None:
    body = markdown_path.read_text().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html_path.write_text(f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>Context-pack pricing simulation</title>
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
    rows = simulate()
    csv_path = REPORT_DIR / "context-pack-pricing-sim.csv"
    json_path = REPORT_DIR / "context-pack-pricing-sim.json"
    md_path = REPORT_DIR / "context-pack-pricing-sim.md"
    html_path = REPORT_DIR / "context-pack-pricing-sim.html"
    write_csv(rows, csv_path)
    json_path.write_text(json.dumps([asdict(row) for row in rows], indent=2))
    write_markdown(rows, md_path)
    write_html(md_path, html_path)
    for path in [md_path, json_path, csv_path, html_path]:
        print(path)


if __name__ == "__main__":
    main()
