#!/usr/bin/env python3
"""Compare payload projections for JSON-like tool output."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

REPORT_DIR = Path("docs/plans/fs-tool-research/reports")
CHARS_PER_TOKEN = 4
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
RETRY_TURN_TOKENS = 80_000
FUTURE_TURNS = 5


def tok(text: str) -> int:
    return max(1, (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN)


@dataclass(frozen=True)
class PayloadCase:
    name: str
    shape: str
    item_count: int
    useful_fields: tuple[str, ...]
    nested: bool
    exact_raw_needed: bool


@dataclass(frozen=True)
class Format:
    name: str
    description: str
    raw_hidden: bool
    projection: bool
    parser_risk: float
    omission_risk: float
    rent_factor: float


@dataclass
class Row:
    case: str
    format: str
    visible_tokens: int
    hidden_bytes: int
    future_rent_tokens: int
    expected_retry_turns: float
    dollars: float
    winner: str
    quality_winner: str


CASES = [
    PayloadCase("package_metadata_12", "metadata", 12, ("name", "version", "license"), True, True),
    PayloadCase("git_status_80", "git", 80, ("path", "status", "rename"), False, False),
    PayloadCase("lsp_diagnostics_120", "diag", 120, ("path", "line", "code", "message"), False, False),
    PayloadCase("test_failures_40", "test", 40, ("file", "test", "error", "stackTop"), True, True),
    PayloadCase("repo_profile_500", "profile", 500, ("path", "bucket", "tokens"), False, False),
    PayloadCase("provider_usage_30", "usage", 30, ("model", "input", "cached", "output", "cost"), True, True),
]

FORMATS = [
    Format("pretty_json", "full pretty JSON", False, False, 0.006, 0.000, 1.00),
    Format("minified_json", "full minified JSON", False, False, 0.010, 0.000, 0.92),
    Format("jsonl_objects", "one minified object per line", False, False, 0.012, 0.002, 0.88),
    Format("tuple_rows", "selected fields as cols+rows", False, True, 0.020, 0.012, 0.68),
    Format("columnar_interned", "selected fields as columns plus interned strings", False, True, 0.032, 0.018, 0.52),
    Format("path_delta_rows", "path-prefixed/delta rows for nested structures", False, True, 0.040, 0.025, 0.48),
    Format("projection_hidden_raw", "compact projection plus hidden raw JSON handle", True, True, 0.018, 0.004, 0.42),
]


def make_payload(case: PayloadCase) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for i in range(case.item_count):
        if case.shape == "metadata":
            rows.append({
                "name": f"pkg-{i}",
                "version": f"1.{i % 7}.{i % 13}",
                "license": ["MIT", "Apache-2.0", "BSD-3-Clause"][i % 3],
                "scripts": {"check": "mise run check", "test": f"vitest run pkg-{i}"},
                "dependencies": {f"dep-{j}": f"^{i % 5}.{j}.0" for j in range(8)},
            })
        elif case.shape == "git":
            rows.append({"path": f"src/feature/{i % 20}/file{i}.ts", "status": ["M", "A", "D", "R"][i % 4], "rename": f"old/file{i}.ts" if i % 4 == 3 else "", "mode": "100644"})
        elif case.shape == "diag":
            rows.append({"path": f"src/{i % 30}/file.ts", "line": 10 + i, "col": i % 80, "code": f"TS{2300 + i % 17}", "message": f"Type mismatch in branch {i % 9}", "related": [{"line": 1, "message": "declared here"}]})
        elif case.shape == "test":
            rows.append({"file": f"tests/{i % 12}/case.test.ts", "test": f"handles case {i}", "error": f"Expected {i % 4} to equal {(i + 1) % 4}", "stackTop": f"at tests/{i % 12}/case.test.ts:{20+i}", "stdout": "x" * (80 + i % 40), "attachments": [{"name": "trace", "bytes": 2048 + i}]})
        elif case.shape == "profile":
            rows.append({"path": f"src/{i % 60}/file{i}.ts", "bucket": ["source", "test", "config", "docs"][i % 4], "tokens": 100 + i % 6000, "lines": 10 + i % 400, "chars": 500 + i * 13})
        elif case.shape == "usage":
            rows.append({"model": ["sonnet", "gpt", "gemini"][i % 3], "input": 20_000 + i * 500, "cached": 10_000 + i * 200, "output": 600 + i * 10, "cost": round(0.02 + i * 0.003, 4), "request": {"id": f"req-{i}", "latencyMs": 800 + i * 7}})
    return rows


def selected_rows(case: PayloadCase, payload: list[dict[str, Any]]) -> list[list[Any]]:
    return [[row.get(field, "") for field in case.useful_fields] for row in payload]


def interned_columns(fields: tuple[str, ...], rows: list[list[Any]]) -> dict[str, Any]:
    strings: dict[str, int] = {}
    data: dict[str, list[Any]] = {field: [] for field in fields}
    for values in rows:
        for field, value in zip(fields, values):
            if isinstance(value, str):
                if value not in strings:
                    strings[value] = len(strings)
                data[field].append(strings[value])
            else:
                data[field].append(value)
    return {"cols": list(fields), "s": {str(v): k for k, v in strings.items()}, "data": data}


def flatten(obj: Any, prefix: str = "") -> list[tuple[str, Any]]:
    if isinstance(obj, dict):
        out: list[tuple[str, Any]] = []
        for key, value in obj.items():
            out.extend(flatten(value, f"{prefix}.{key}" if prefix else key))
        return out
    if isinstance(obj, list):
        out = []
        for i, value in enumerate(obj[:3]):
            out.extend(flatten(value, f"{prefix}[{i}]"))
        return out
    return [(prefix, obj)]


def render(case: PayloadCase, fmt: Format) -> tuple[str, int]:
    payload = make_payload(case)
    raw = json.dumps(payload, separators=(",", ":"))
    hidden = len(raw.encode()) if fmt.raw_hidden else 0
    if fmt.name == "pretty_json":
        return json.dumps(payload, indent=2), hidden
    if fmt.name == "minified_json":
        return raw, hidden
    if fmt.name == "jsonl_objects":
        return "\n".join(json.dumps(row, separators=(",", ":")) for row in payload), hidden
    rows = selected_rows(case, payload)
    if fmt.name == "tuple_rows":
        return json.dumps({"cols": list(case.useful_fields), "rows": rows}, separators=(",", ":")), hidden
    if fmt.name == "columnar_interned":
        return json.dumps(interned_columns(case.useful_fields, rows), separators=(",", ":")), hidden
    if fmt.name == "path_delta_rows":
        flat = []
        for i, item in enumerate(payload[: min(case.item_count, 120)]):
            for path, value in flatten(item):
                if any(field in path for field in case.useful_fields):
                    flat.append([i, path, value])
        return json.dumps({"d": flat}, separators=(",", ":")), hidden
    if fmt.name == "projection_hidden_raw":
        projection = {"raw": "@json1", "cols": list(case.useful_fields), "rows": rows[:200], "droppedRows": max(0, len(rows) - 200)}
        return json.dumps(projection, separators=(",", ":")), hidden
    raise ValueError(fmt.name)


def retry(case: PayloadCase, fmt: Format, visible_tokens: int) -> float:
    omit = fmt.omission_risk
    if case.exact_raw_needed and not fmt.raw_hidden and fmt.projection:
        omit += 0.10
    if case.nested and fmt.name in {"tuple_rows", "columnar_interned"}:
        omit += 0.04
    if case.item_count > 200 and fmt.name in {"pretty_json", "minified_json", "jsonl_objects"}:
        omit += 0.04
    compact_confusion = max(0, 500 - visible_tokens) / 25_000
    return round(min(0.70, fmt.parser_risk + omit + compact_confusion), 3)


def dollars(visible: int, rent: int, retry_turns: float) -> float:
    cached = rent + retry_turns * RETRY_TURN_TOKENS
    return round(visible / 1_000_000 * INPUT_PER_MTOK + cached / 1_000_000 * CACHED_PER_MTOK, 6)


def simulate() -> list[Row]:
    out: list[Row] = []
    for case in CASES:
        local: list[Row] = []
        for fmt in FORMATS:
            rendered, hidden = render(case, fmt)
            visible = tok(rendered)
            rent = int(visible * fmt.rent_factor * FUTURE_TURNS)
            expected_retry = retry(case, fmt, visible)
            local.append(Row(case.name, fmt.name, visible, hidden, rent, expected_retry, dollars(visible, rent, expected_retry), "", ""))
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.expected_retry_turns <= 0.16 or row.format == "projection_hidden_raw"]
        quality_best = min(row.dollars for row in qualified)
        for row in local:
            row.winner = "winner" if row.dollars == best else ""
            row.quality_winner = "quality_winner" if row.dollars == quality_best and row in qualified else ""
        out.extend(local)
    return out


def write_csv(path: Path, rows: list[Row]) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def write_json(path: Path, rows: list[Row]) -> None:
    path.write_text(json.dumps({"cases": [asdict(c) for c in CASES], "formats": [asdict(f) for f in FORMATS], "rows": [asdict(r) for r in rows]}, indent=2))


def write_md(path: Path, rows: list[Row]) -> None:
    wins: dict[str, int] = {}
    quality: dict[str, int] = {}
    for row in rows:
        if row.winner:
            wins[row.format] = wins.get(row.format, 0) + 1
        if row.quality_winner:
            quality[row.format] = quality.get(row.format, 0) + 1
    lines = [
        "# JSON payload format simulation",
        "",
        "Question: what visible format should arbitrary JSON-like tool payloads compile to?",
        "",
        "## Winner counts",
        "",
        "| format | cost wins | quality-gated wins |",
        "|---|---:|---:|",
    ]
    for name in sorted(set(wins) | set(quality)):
        lines.append(f"| {name} | {wins.get(name, 0)} | {quality.get(name, 0)} |")
    lines += [
        "",
        "## Case detail",
        "",
        "| case | format | visible | hidden bytes | rent | retry | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---:|---|",
    ]
    for case in CASES:
        for row in sorted([r for r in rows if r.case == case.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.case} | {row.format} | {row.visible_tokens:,} | {row.hidden_bytes:,} | {row.future_rent_tokens:,} | {row.expected_retry_turns:.2f} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Default arbitrary JSON should not be dumped raw into provider context.",
        "- For row-like payloads, tuple/columnar formats save large tokens; use tuple unless repeated strings make interning worthwhile.",
        "- For nested/high-fidelity payloads, compact projection plus hidden raw JSON handle is the safer default.",
        "- Pretty JSON is a debug/expand view, not normal model context.",
        "- Path-delta rows are niche: useful for nested diffs, too weird as generic output.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>JSON payload format simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "json-payload-format-sim.md"
    json_path = REPORT_DIR / "json-payload-format-sim.json"
    csv_path = REPORT_DIR / "json-payload-format-sim.csv"
    html_path = REPORT_DIR / "json-payload-format-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
