#!/usr/bin/env python3
"""Compare LSP/code-intelligence routes against text-edit routes."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/plans/fs-tool-research/reports")
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
RETRY_CONTEXT_TOKENS = 80_000
WRONG_EDIT_PENALTY_TURNS = 8
LATENCY_PENALTY_PER_SECOND = 0.00035


@dataclass(frozen=True)
class Scenario:
    name: str
    description: str
    files: int
    refs: int
    read_tokens: int
    semantic: bool
    import_op: bool
    diagnostics: bool
    lsp_state: str
    workspace_op: bool = False
    dynamic_code: bool = False


@dataclass(frozen=True)
class Strategy:
    name: str
    description: str
    needs_lsp: bool
    workspace_edit: bool
    semantic_route: bool
    base_retry: float
    wrong_risk: float


@dataclass
class Row:
    scenario: str
    strategy: str
    visible_tokens: int
    mutation_tokens: int
    hidden_bytes: int
    latency_seconds: float
    expected_retry_turns: float
    wrong_edit_risk: float
    dollars: float
    winner: str
    quality_winner: str


SCENARIOS = [
    Scenario("tiny_text_edit", "one obvious non-semantic line edit", 1, 1, 1_800, False, False, False, "cold"),
    Scenario("local_rename_3_refs", "rename a local symbol with three refs", 2, 3, 3_800, True, False, False, "cold", workspace_op=True),
    Scenario("workspace_rename_60_refs", "workspace symbol rename across many files", 22, 60, 28_000, True, False, False, "warm", workspace_op=True),
    Scenario("organize_imports_18_files", "organize imports after broad edit", 18, 18, 14_000, True, True, False, "warm", workspace_op=True),
    Scenario("diagnostic_fix_12_errors", "use diagnostics to drive fix", 5, 12, 9_000, True, False, True, "warm"),
    Scenario("dynamic_string_api", "stringly named API not visible to LSP", 12, 24, 18_000, False, False, False, "warm", dynamic_code=True),
    Scenario("broken_tsconfig", "project LSP unavailable or misconfigured", 8, 20, 12_000, True, False, True, "unavailable"),
    Scenario("find_refs_debug", "understand call graph before small fix", 7, 35, 10_000, True, False, False, "cold"),
]

STRATEGIES = [
    Strategy("grep_model_edit", "grep/search, read ranges, model edits text", False, False, False, 0.080, 0.025),
    Strategy("apply_patch", "patch/diff with context", False, False, False, 0.060, 0.018),
    Strategy("hidden_handle_batch", "managed read handles plus batch tuple edits", False, False, False, 0.035, 0.006),
    Strategy("lsp_refs_model_edit", "LSP refs/defs/diagnostics feed managed text edits", True, False, True, 0.025, 0.004),
    Strategy("lsp_workspace_edit", "LSP rename/organize workspace edit", True, True, True, 0.015, 0.003),
    Strategy("code_probe_codemod", "controlled AST/codemod probe then harness mutation", False, True, True, 0.040, 0.010),
]


def lsp_latency(s: Scenario, st: Strategy) -> float:
    if not st.needs_lsp:
        return 0.8 if st.name == "code_probe_codemod" else 0.2
    if s.lsp_state == "unavailable":
        return 8.0
    base = 6.0 if s.lsp_state == "cold" else 0.8
    return round(base + s.files * 0.05 + s.refs * 0.01, 2)


def visible_tokens(s: Scenario, st: Strategy) -> int:
    if st.needs_lsp and s.lsp_state == "unavailable":
        return 1_200
    if st.name == "grep_model_edit":
        return int(s.read_tokens * (0.65 if s.files > 8 else 0.9)) + s.refs * 35
    if st.name == "apply_patch":
        return int(s.read_tokens * 0.75) + s.refs * 28
    if st.name == "hidden_handle_batch":
        return int(s.read_tokens * 0.70) + s.refs * 12 + 80
    if st.name == "lsp_refs_model_edit":
        read_factor = 0.12 if s.diagnostics else 0.30
        return 300 + s.refs * 18 + int(s.read_tokens * read_factor)
    if st.name == "lsp_workspace_edit":
        return 220 + s.refs * 8
    if st.name == "code_probe_codemod":
        multiplier = 0.20 if (s.dynamic_code or s.refs > 8) else 0.80
        return 500 + s.refs * 14 + int(s.read_tokens * multiplier)
    raise ValueError(st.name)


def mutation_tokens(s: Scenario, st: Strategy) -> int:
    if st.name == "grep_model_edit":
        return 120 + s.refs * 24
    if st.name == "apply_patch":
        return 240 + s.refs * 42
    if st.name == "hidden_handle_batch":
        return 90 + s.refs * 10
    if st.name == "lsp_refs_model_edit":
        return 120 + s.refs * 10
    if st.name == "lsp_workspace_edit":
        return 70
    if st.name == "code_probe_codemod":
        return 180 + s.refs * (8 if (s.dynamic_code or s.refs > 8) else 20)
    raise ValueError(st.name)


def retry_and_wrong(s: Scenario, st: Strategy) -> tuple[float, float]:
    if st.needs_lsp and s.lsp_state == "unavailable":
        return 0.95, 0.004
    retry = st.base_retry
    wrong = st.wrong_risk
    if s.semantic and not st.semantic_route:
        retry += min(0.65, s.refs * 0.012)
        wrong += min(0.08, s.refs * 0.001)
    if st.name == "lsp_workspace_edit" and not s.workspace_op:
        retry += 0.70
    if s.import_op and st.name != "lsp_workspace_edit":
        retry += 0.10
    if s.diagnostics and st.name in {"grep_model_edit", "apply_patch", "hidden_handle_batch"}:
        retry += 0.12
    if s.dynamic_code and st.needs_lsp:
        retry += 0.38
        wrong += 0.025
    if st.name == "code_probe_codemod" and s.dynamic_code:
        retry -= 0.08
    if st.name == "code_probe_codemod" and not s.dynamic_code and s.refs <= 3:
        retry += 0.10
    if s.files <= 2 and st.needs_lsp and s.lsp_state == "cold":
        retry += 0.03
    return round(min(1.2, max(0.0, retry)), 3), round(min(0.20, wrong), 4)


def dollars(visible: int, mutation: int, retry: float, wrong: float, latency: float) -> float:
    cached = retry * RETRY_CONTEXT_TOKENS + wrong * WRONG_EDIT_PENALTY_TURNS * RETRY_CONTEXT_TOKENS
    return round(
        (visible + mutation) / 1_000_000 * INPUT_PER_MTOK
        + cached / 1_000_000 * CACHED_PER_MTOK
        + latency * LATENCY_PENALTY_PER_SECOND,
        6,
    )


def quality_ok(s: Scenario, st: Strategy, row: Row) -> bool:
    if st.needs_lsp and s.lsp_state == "unavailable":
        return False
    if s.semantic and s.refs >= 20 and not st.semantic_route:
        return False
    if st.name == "lsp_workspace_edit" and not s.workspace_op:
        return False
    return row.expected_retry_turns <= 0.35 and row.wrong_edit_risk <= 0.035


def simulate() -> list[Row]:
    rows: list[Row] = []
    for scenario in SCENARIOS:
        local: list[Row] = []
        for strategy in STRATEGIES:
            visible = visible_tokens(scenario, strategy)
            mutation = mutation_tokens(scenario, strategy)
            hidden = scenario.read_tokens * 4 if strategy.name in {"hidden_handle_batch", "lsp_refs_model_edit", "code_probe_codemod"} else 0
            latency = lsp_latency(scenario, strategy)
            retry, wrong = retry_and_wrong(scenario, strategy)
            local.append(Row(scenario.name, strategy.name, visible, mutation, hidden, latency, retry, wrong, dollars(visible, mutation, retry, wrong, latency), "", ""))
        best = min(row.dollars for row in local)
        qualified = [row for row in local if quality_ok(scenario, next(st for st in STRATEGIES if st.name == row.strategy), row)] or local
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
        "# LSP vs edit simulation",
        "",
        "Question: when should the harness use LSP/code intelligence instead of text edits/search?",
        "",
        "Latency is priced lightly as a score penalty so cold-start cost can beat token savings for tiny one-offs.",
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
        "| scenario | strategy | visible | mutation | hidden bytes | latency s | retry | wrong risk | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for scenario in SCENARIOS:
        for row in sorted([r for r in rows if r.scenario == scenario.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.scenario} | {row.strategy} | {row.visible_tokens:,} | {row.mutation_tokens:,} | {row.hidden_bytes:,} | {row.latency_seconds:.1f} | {row.expected_retry_turns:.2f} | {row.wrong_edit_risk:.1%} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Text handles win tiny obvious edits, especially when LSP is cold.",
        "- LSP wins semantic workspace rename/imports, and LSP refs/diagnostics are strong when server is warm.",
        "- Best normal route is hybrid: LSP for meaning, hidden-handle batch mutation for text changes that remain.",
        "- Broken tsconfig/unavailable LSP must fail over to text/search; do not make LSP a hard dependency.",
        "- Dynamic/stringly code still needs grep/probe coverage. LSP finds meaning, not every runtime string convention.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>LSP vs edit simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "lsp-vs-edit-sim.md"
    json_path = REPORT_DIR / "lsp-vs-edit-sim.json"
    csv_path = REPORT_DIR / "lsp-vs-edit-sim.csv"
    html_path = REPORT_DIR / "lsp-vs-edit-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
