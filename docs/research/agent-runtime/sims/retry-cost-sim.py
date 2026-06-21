#!/usr/bin/env python3
"""Compare stale/duplicate edit retry policies."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/retry-cost-sim")
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
RETRY_TURN_TOKENS = 80_000
WRONG_EDIT_PENALTY_TURNS = 8


@dataclass(frozen=True)
class Case:
    name: str
    description: str
    read_tokens: int
    edit_tokens: int
    duplicate_candidates: int
    digest_changed: bool
    old_block_unique: bool
    neighbor_unique: bool
    line_shift: int
    moved: bool
    semantic: bool = False


@dataclass(frozen=True)
class Policy:
    name: str
    description: str
    base_tokens: int
    can_apply_on_digest_match: bool
    can_relocate_exact_unique: bool
    can_relocate_neighbor: bool
    fuzzy_model_relocate: bool
    duplicate_wrong_risk: float
    stale_fail_cost: float


@dataclass
class Row:
    case: str
    policy: str
    request_tokens: int
    expected_retry_turns: float
    wrong_edit_risk: float
    dollars: float
    winner: str
    quality_winner: str


CASES = [
    Case("fresh_unique", "fresh digest, unique old block", 2_000, 120, 1, False, True, True, 0, False),
    Case("fresh_duplicate_line", "fresh digest, duplicate target text", 2_200, 130, 5, False, False, True, 0, False),
    Case("line_shift_same_digest", "line numbers stale but digest/snapshot still usable", 2_800, 180, 1, False, True, True, 12, False),
    Case("stale_moved_unique", "digest changed, exact old block moved and remains unique", 3_000, 220, 1, True, True, True, 60, True),
    Case("stale_moved_duplicate", "digest changed, old block exists in multiple locations", 3_000, 220, 4, True, False, False, 60, True),
    Case("stale_neighbor_unique", "digest changed, old block changed slightly but neighbors unique", 3_200, 260, 1, True, False, True, 40, True),
    Case("concurrent_nearby_edit", "digest changed due to nearby human edit", 3_500, 260, 2, True, False, True, 5, False),
    Case("semantic_rename_shifted", "semantic rename after files shifted", 6_000, 80, 12, True, False, False, 100, True, semantic=True),
]

POLICIES = [
    Policy("exact_old_string", "exact old/new text replacement", 180, True, True, False, False, 0.025, 0.80),
    Policy("apply_patch_context", "patch context matcher", 320, True, True, True, False, 0.018, 0.60),
    Policy("visible_hashline", "line+visible hash anchors", 180, True, False, False, False, 0.010, 0.65),
    Policy("hidden_handle_strict", "hidden handle applies only when digest matches", 90, True, False, False, False, 0.002, 1.00),
    Policy("hidden_handle_exact_relocate", "hidden handle relocates only exact unique old block", 130, True, True, False, False, 0.004, 0.55),
    Policy("hidden_handle_neighbor_relocate", "exact unique first, then unique neighbor pair", 160, True, True, True, False, 0.009, 0.45),
    Policy("hidden_handle_fuzzy_model", "model/fuzzy relocation after stale digest", 120, True, True, True, True, 0.050, 0.35),
    Policy("lsp_semantic", "semantic LSP edit/rename", 80, True, True, True, False, 0.006, 0.40),
]


def retry_and_wrong(case: Case, policy: Policy) -> tuple[float, float]:
    if policy.name == "lsp_semantic" and not case.semantic:
        return 0.50, 0.020
    if case.semantic and policy.name != "lsp_semantic":
        return 0.45, 0.030

    retry = 0.02
    wrong = policy.duplicate_wrong_risk / max(1, case.duplicate_candidates)

    if not case.digest_changed:
        if policy.name == "hidden_handle_strict":
            return 0.015, 0.001
        if case.duplicate_candidates > 1 and policy.name in {"exact_old_string", "apply_patch_context"}:
            retry += 0.08
            wrong += 0.020
        return round(retry, 3), round(wrong, 4)

    # Digest changed. Strict handles fail tight and force reread/retry.
    if policy.name == "hidden_handle_strict":
        return round(policy.stale_fail_cost, 3), 0.0005

    if policy.can_relocate_exact_unique and case.old_block_unique:
        retry += 0.06
        wrong += 0.003
    elif policy.can_relocate_neighbor and case.neighbor_unique:
        retry += 0.12
        wrong += 0.012
    elif policy.fuzzy_model_relocate:
        retry += 0.18
        wrong += 0.055 + 0.015 * max(0, case.duplicate_candidates - 1)
    else:
        retry += policy.stale_fail_cost
        wrong += 0.002

    if case.moved and not (policy.can_relocate_exact_unique or policy.can_relocate_neighbor or policy.fuzzy_model_relocate):
        retry += 0.12
    if case.duplicate_candidates > 2 and policy.name in {"exact_old_string", "apply_patch_context"}:
        wrong += 0.030
    return round(min(1.2, retry), 3), round(min(0.35, wrong), 4)


def dollars(tokens: int, retry: float, wrong: float) -> float:
    cached = retry * RETRY_TURN_TOKENS + wrong * WRONG_EDIT_PENALTY_TURNS * RETRY_TURN_TOKENS
    return round(tokens / 1_000_000 * INPUT_PER_MTOK + cached / 1_000_000 * CACHED_PER_MTOK, 6)


def simulate() -> list[Row]:
    rows: list[Row] = []
    for case in CASES:
        local: list[Row] = []
        for policy in POLICIES:
            request = case.read_tokens + case.edit_tokens + policy.base_tokens
            retry, wrong = retry_and_wrong(case, policy)
            local.append(Row(case.name, policy.name, request, retry, wrong, dollars(request, retry, wrong), "", ""))
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.wrong_edit_risk <= 0.012 and row.expected_retry_turns <= 0.70]
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
    path.write_text(json.dumps({"cases": [asdict(c) for c in CASES], "policies": [asdict(p) for p in POLICIES], "rows": [asdict(r) for r in rows]}, indent=2))


def write_md(path: Path, rows: list[Row]) -> None:
    wins: dict[str, int] = {}
    quality: dict[str, int] = {}
    for row in rows:
        if row.winner:
            wins[row.policy] = wins.get(row.policy, 0) + 1
        if row.quality_winner:
            quality[row.policy] = quality.get(row.policy, 0) + 1
    lines = [
        "# Retry-cost simulation",
        "",
        "Question: should stale hidden handles fail tight or relocate?",
        "",
        "Wrong edits get an explicit penalty because cheap wrong mutation is fake savings.",
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
        "## Case detail",
        "",
        "| case | policy | tokens | retry turns | wrong risk | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---|",
    ]
    for case in CASES:
        for row in sorted([r for r in rows if r.case == case.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.case} | {row.policy} | {row.request_tokens:,} | {row.expected_retry_turns:.2f} | {row.wrong_edit_risk:.2%} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Strict hidden handles are safest for fresh/current reads and duplicate text, but expensive when files changed under them.",
        "- Exact-unique relocation is worth supporting after V1: it recovers moved blocks with tiny wrong-edit risk.",
        "- Neighbor relocation is useful but riskier; gate it behind uniqueness and digest/neighbor evidence.",
        "- Fuzzy/model relocation is not a default edit path. It is cheap-looking until wrong-edit penalty lands.",
        "- `apply_patch` remains useful as compatibility/fallback, especially where stale context can still match safely.",
        "- Semantic edits should route to LSP, not stale text relocation.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Retry-cost simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "retry-cost-sim.md"
    json_path = REPORT_DIR / "retry-cost-sim.json"
    csv_path = REPORT_DIR / "retry-cost-sim.csv"
    html_path = REPORT_DIR / "retry-cost-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
