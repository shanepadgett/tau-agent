#!/usr/bin/env python3
"""Price whole-file context against extra discovery turns."""

from __future__ import annotations

import csv
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import median

REPORT_DIR = Path("docs/plans/fs-tool-research/reports")
PROFILE_CSV = REPORT_DIR / "repo-size-profile.csv"

OWNED_BUCKETS = {"source", "test", "docs", "config", "text-other"}
BASE_CONTEXT_TOKENS = [20_000, 80_000, 160_000]
FUTURE_TURNS = [1, 4, 8]
EXTRA_DISCOVERY_TURNS = [1, 2, 4]
DISCOVERY_NOISE_PER_TURN = [0, 750, 1_500, 3_000]
SIZE_CASES = ["p50", "p75", "p90", "p95", "max"]
OUTPUT_TOKENS_PER_TURN = 650
RANGE_MIN_TOKENS = 300
RANGE_MAX_TOKENS = 2_000
RANGE_FRACTION = 0.2

MODELS = [
    {"name": "sonnet-ish", "input_per_mtok": 3.0, "cached_input_per_mtok": 0.30, "output_per_mtok": 15.0, "cache_ratio": 0.85},
    {"name": "sonnet-poor-cache", "input_per_mtok": 3.0, "cached_input_per_mtok": 0.30, "output_per_mtok": 15.0, "cache_ratio": 0.25},
    {"name": "opus-ish", "input_per_mtok": 15.0, "cached_input_per_mtok": 1.50, "output_per_mtok": 75.0, "cache_ratio": 0.85},
    {"name": "cheap-ish", "input_per_mtok": 0.50, "cached_input_per_mtok": 0.05, "output_per_mtok": 2.0, "cache_ratio": 0.85},
]


@dataclass
class FileRow:
    repo: str
    bucket: str
    tokens: int


@dataclass
class ScenarioRow:
    repo: str
    bucket: str
    size_case: str
    file_tokens: int
    range_tokens: int
    model: str
    base_context_tokens: int
    future_turns: int
    extra_discovery_turns: int
    discovery_noise_per_turn: int
    whole_effective_tokens: int
    range_now_effective_tokens: int
    discovery_pruned_effective_tokens: int
    discovery_raw_effective_tokens: int
    whole_dollars: float
    range_now_dollars: float
    discovery_pruned_dollars: float
    discovery_raw_dollars: float
    winner_pruned: str
    winner_raw: str


def effective_input_tokens(input_tokens: int, cache_ratio: float, cached_multiplier: float) -> float:
    return input_tokens * ((1 - cache_ratio) + cache_ratio * cached_multiplier)


def dollars(input_tokens: float, output_tokens: float, model: dict[str, float | str]) -> float:
    return (input_tokens / 1_000_000 * float(model["input_per_mtok"])) + (output_tokens / 1_000_000 * float(model["output_per_mtok"]))


def range_size(file_tokens: int) -> int:
    if file_tokens <= RANGE_MAX_TOKENS:
        return file_tokens
    return min(RANGE_MAX_TOKENS, max(RANGE_MIN_TOKENS, round(file_tokens * RANGE_FRACTION)))


def percentile(values: list[int], pct: float) -> int:
    ordered = sorted(values)
    return ordered[round((len(ordered) - 1) * pct)]


def size_cases(tokens: list[int]) -> dict[str, int]:
    return {
        "p50": int(median(tokens)),
        "p75": percentile(tokens, 0.75),
        "p90": percentile(tokens, 0.90),
        "p95": percentile(tokens, 0.95),
        "max": max(tokens),
    }


def load_files() -> list[FileRow]:
    if not PROFILE_CSV.exists():
        raise SystemExit(f"missing {PROFILE_CSV}; run repo-size-profile.py first")
    rows: list[FileRow] = []
    with PROFILE_CSV.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            tokens = int(row["tokens_4"])
            if row["bucket"] in OWNED_BUCKETS and tokens > 0:
                rows.append(FileRow(row["repo"], row["bucket"], tokens))
    return rows


def grouped_files(files: list[FileRow]) -> dict[tuple[str, str], list[FileRow]]:
    groups: dict[tuple[str, str], list[FileRow]] = {}
    for file in files:
        groups.setdefault((file.repo, file.bucket), []).append(file)
    return groups


def cost_whole(file_tokens: int, base: int, future: int, model: dict[str, float | str]) -> tuple[int, float]:
    cache_ratio = float(model["cache_ratio"])
    cached_multiplier = float(model["cached_input_per_mtok"]) / float(model["input_per_mtok"])
    current = effective_input_tokens(base + file_tokens, cache_ratio, cached_multiplier)
    future_cost = future * effective_input_tokens(base + file_tokens, cache_ratio, cached_multiplier)
    output = OUTPUT_TOKENS_PER_TURN
    return round(current + future_cost + output), dollars(current + future_cost, output, model)


def cost_range_now(tokens: int, base: int, future: int, model: dict[str, float | str]) -> tuple[int, float]:
    cache_ratio = float(model["cache_ratio"])
    cached_multiplier = float(model["cached_input_per_mtok"]) / float(model["input_per_mtok"])
    current = effective_input_tokens(base + tokens, cache_ratio, cached_multiplier)
    future_cost = future * effective_input_tokens(base + tokens, cache_ratio, cached_multiplier)
    output = OUTPUT_TOKENS_PER_TURN
    return round(current + future_cost + output), dollars(current + future_cost, output, model)


def cost_discovery(tokens: int, base: int, future: int, turns: int, noise: int, keep_raw_noise: bool, model: dict[str, float | str]) -> tuple[int, float]:
    cache_ratio = float(model["cache_ratio"])
    cached_multiplier = float(model["cached_input_per_mtok"]) / float(model["input_per_mtok"])
    discovery = 0.0
    for turn in range(1, turns + 1):
        found = round(tokens * turn / turns)
        visible = base + found + noise * turn
        discovery += effective_input_tokens(visible, cache_ratio, cached_multiplier)
    retained_noise = noise * turns if keep_raw_noise else 0
    future_cost = future * effective_input_tokens(base + tokens + retained_noise, cache_ratio, cached_multiplier)
    output = turns * OUTPUT_TOKENS_PER_TURN
    return round(discovery + future_cost + output), dollars(discovery + future_cost, output, model)


def choose_winner(whole_cost: float, other_cost: float, other_label: str) -> str:
    if abs(whole_cost - other_cost) < 0.0000005:
        return "tie"
    return "whole" if whole_cost < other_cost else other_label


def simulate(files: list[FileRow]) -> list[ScenarioRow]:
    rows: list[ScenarioRow] = []
    for (repo, bucket), group in sorted(grouped_files(files).items()):
        for size_case, file_tokens in size_cases([file.tokens for file in group]).items():
            r_tokens = range_size(file_tokens)
            for model in MODELS:
                for base in BASE_CONTEXT_TOKENS:
                    for future in FUTURE_TURNS:
                        whole_effective, whole_cost = cost_whole(file_tokens, base, future, model)
                        range_effective, range_cost = cost_range_now(r_tokens, base, future, model)
                        for turns in EXTRA_DISCOVERY_TURNS:
                            for noise in DISCOVERY_NOISE_PER_TURN:
                                pruned_effective, pruned_cost = cost_discovery(r_tokens, base, future, turns, noise, False, model)
                                raw_effective, raw_cost = cost_discovery(r_tokens, base, future, turns, noise, True, model)
                                rows.append(ScenarioRow(
                                    repo=repo,
                                    bucket=bucket,
                                    size_case=size_case,
                                    file_tokens=file_tokens,
                                    range_tokens=r_tokens,
                                    model=str(model["name"]),
                                    base_context_tokens=base,
                                    future_turns=future,
                                    extra_discovery_turns=turns,
                                    discovery_noise_per_turn=noise,
                                    whole_effective_tokens=whole_effective,
                                    range_now_effective_tokens=range_effective,
                                    discovery_pruned_effective_tokens=pruned_effective,
                                    discovery_raw_effective_tokens=raw_effective,
                                    whole_dollars=round(whole_cost, 6),
                                    range_now_dollars=round(range_cost, 6),
                                    discovery_pruned_dollars=round(pruned_cost, 6),
                                    discovery_raw_dollars=round(raw_cost, 6),
                                    winner_pruned=choose_winner(whole_cost, pruned_cost, "discovery_pruned"),
                                    winner_raw=choose_winner(whole_cost, raw_cost, "discovery_raw"),
                                ))
    return rows


def write_csv(rows: list[ScenarioRow], path: Path) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def winner_for(file_tokens: int, turns: int, noise: int) -> str:
    model = MODELS[0]
    whole_cost = cost_whole(file_tokens, 80_000, 4, model)[1]
    raw_cost = cost_discovery(range_size(file_tokens), 80_000, 4, turns, noise, True, model)[1]
    return choose_winner(whole_cost, raw_cost, "range")


def json_summary(files: list[FileRow], rows: list[ScenarioRow]) -> dict[str, object]:
    terrain = []
    for (repo, bucket), group in sorted(grouped_files(files).items()):
        tokens = [file.tokens for file in group]
        cases = size_cases(tokens)
        terrain.append({
            "repo": repo,
            "bucket": bucket,
            "files": len(group),
            **cases,
            "lte_2k": sum(1 for token in tokens if token <= 2_000),
            "lte_3k": sum(1 for token in tokens if token <= 3_000),
            "lte_5k": sum(1 for token in tokens if token <= 5_000),
        })
    representative = [
        asdict(row) for row in rows
        if row.model == "sonnet-ish"
        and row.base_context_tokens == 80_000
        and row.future_turns == 4
        and row.discovery_noise_per_turn == 1_500
    ]
    total = len(rows)
    return {
        "rows_in_csv": total,
        "whole_win_pruned_share": round(sum(1 for row in rows if row.winner_pruned == "whole") / total, 4),
        "whole_win_raw_share": round(sum(1 for row in rows if row.winner_raw == "whole") / total, 4),
        "terrain": terrain,
        "representative_rows": representative,
    }


def write_markdown(files: list[FileRow], rows: list[ScenarioRow], path: Path) -> None:
    total = len(rows)
    whole_pruned = sum(1 for row in rows if row.winner_pruned == "whole")
    whole_raw = sum(1 for row in rows if row.winner_raw == "whole")
    lines = [
        "# Turn-cost simulation",
        "",
        "Question: when is reading more file context cheaper than spending extra model turns discovering a smaller range?",
        "",
        "Inputs come from `repo-size-profile.csv`. Owned buckets only: source, test, docs, config, text-other. Sim rows use bucket percentiles, not every file, to keep reports small.",
        "",
        f"Rows: {total:,}. Whole-read wins vs pruned discovery: {whole_pruned / total:.1%}. Whole-read wins vs raw retained discovery: {whole_raw / total:.1%}.",
        "",
        "## File terrain by repo/bucket",
        "",
        "| repo | bucket | files | p50 | p75 | p90 | p95 | max | <=2k | <=3k | <=5k |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for (repo, bucket), group in sorted(grouped_files(files).items()):
        tokens = [file.tokens for file in group]
        cases = size_cases(tokens)
        lines.append(
            f"| {repo} | {bucket} | {len(group):,} | {cases['p50']:,} | {cases['p75']:,} | {cases['p90']:,} | {cases['p95']:,} | {cases['max']:,} | "
            f"{sum(1 for token in tokens if token <= 2_000):,} | {sum(1 for token in tokens if token <= 3_000):,} | {sum(1 for token in tokens if token <= 5_000):,} |"
        )

    lines += [
        "",
        "## Representative file-size cases, sonnet-ish, base 80k, future 4, raw noise retained",
        "",
        "| repo | bucket | size | file tokens | range tokens | 1 turn/0 noise | 1 turn/1.5k noise | 2 turns/1.5k | 4 turns/1.5k |",
        "|---|---|---|---:|---:|---|---|---|---|",
    ]
    for (repo, bucket), group in sorted(grouped_files(files).items()):
        for case, token_count in size_cases([file.tokens for file in group]).items():
            if case not in {"p50", "p90", "p95"}:
                continue
            lines.append(
                f"| {repo} | {bucket} | {case} | {token_count:,} | {range_size(token_count):,} | "
                f"{winner_for(token_count, 1, 0)} | {winner_for(token_count, 1, 1_500)} | {winner_for(token_count, 2, 1_500)} | {winner_for(token_count, 4, 1_500)} |"
            )

    lines += [
        "",
        "## Threshold takeaways",
        "",
        "- `range_now` is always cheapest on tokens, but may be wrong if the selected range misses needed context. Treat it as lower bound, not policy.",
        "- Whole-read becomes attractive when it avoids even one noisy discovery turn, especially for files under 3k-5k tokens.",
        "- If discovery is exact, one turn, and pruned, range discovery can beat whole-read on large files. Good: the sim has teeth.",
        "- If raw search/read noise stays in context, whole-read wins more often. That supports managed capsules/pruning.",
        "- Candidate starting policy: auto-read owned source/test/config <=3k tokens, consider <=5k when scope confidence is high, range-read above that, never auto-read generated/vendor.",
    ]
    path.write_text("\n".join(lines))


def write_html(markdown_path: Path, html_path: Path) -> None:
    body = markdown_path.read_text().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html_path.write_text(f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>Turn-cost simulation</title>
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
    files = load_files()
    rows = simulate(files)
    csv_path = REPORT_DIR / "turn-cost-sim.csv"
    json_path = REPORT_DIR / "turn-cost-sim.json"
    md_path = REPORT_DIR / "turn-cost-sim.md"
    html_path = REPORT_DIR / "turn-cost-sim.html"
    write_csv(rows, csv_path)
    json_path.write_text(json.dumps(json_summary(files, rows), indent=2))
    write_markdown(files, rows, md_path)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
