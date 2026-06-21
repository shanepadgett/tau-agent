#!/usr/bin/env python3
"""Compare schema/output shapes for repeated tool rows."""

from __future__ import annotations

import csv
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/schema-shape-sim")
CHARS_PER_TOKEN = 4
INPUT_PER_MTOK = 3.00
CACHED_PER_MTOK = 0.30
RETRY_TURN_TOKENS = 80_000
FUTURE_TURNS = 5


def tok(text: str) -> int:
    return max(1, (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN)


@dataclass(frozen=True)
class Dataset:
    name: str
    kind: str
    rows: int
    fields: tuple[str, ...]
    repeated_paths: int
    repeated_codes: int
    nested: bool = False


@dataclass(frozen=True)
class Shape:
    name: str
    description: str
    parser_risk: float
    missing_field_risk: float
    future_visibility_factor: float


@dataclass
class Row:
    dataset: str
    shape: str
    visible_tokens: int
    future_rent_tokens: int
    expected_retry_turns: float
    effective_tokens: int
    dollars: float
    winner: str
    quality_winner: str


DATASETS = [
    Dataset("search_8", "search", 8, ("path", "line", "text"), 4, 0),
    Dataset("search_80", "search", 80, ("path", "line", "text"), 12, 0),
    Dataset("diagnostics_20", "diagnostic", 20, ("path", "line", "col", "severity", "code", "message"), 6, 8),
    Dataset("diagnostics_200", "diagnostic", 200, ("path", "line", "col", "severity", "code", "message"), 20, 14),
    Dataset("capsules_40", "capsule", 40, ("id", "type", "path", "state", "digest", "summary"), 20, 0),
    Dataset("lsp_refs_120", "reference", 120, ("path", "line", "col", "symbol", "context"), 18, 1),
]

SHAPES = [
    Shape("pretty_object_json", "pretty JSON list of objects", 0.010, 0.002, 1.00),
    Shape("minified_object_json", "minified JSON list of objects", 0.012, 0.003, 0.95),
    Shape("tuple_rows_legend", "one legend plus tuple rows", 0.020, 0.006, 0.72),
    Shape("columnar_arrays", "columns stored as arrays", 0.030, 0.010, 0.60),
    Shape("interned_tuple_rows", "legend plus string intern table plus tuple rows", 0.026, 0.008, 0.50),
    Shape("terse_lines", "compact human lines with implicit fields", 0.045, 0.030, 0.55),
]


def make_rows(dataset: Dataset) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for i in range(dataset.rows):
        path = f"src/{dataset.kind}/file{i % dataset.repeated_paths}.ts"
        code = f"E{i % max(1, dataset.repeated_codes):03d}" if dataset.repeated_codes else ""
        row: dict[str, object] = {}
        for field in dataset.fields:
            if field == "path":
                row[field] = path
            elif field == "line":
                row[field] = 10 + i * 3
            elif field == "col":
                row[field] = 2 + i % 80
            elif field == "severity":
                row[field] = "error" if i % 5 == 0 else "warning"
            elif field == "code":
                row[field] = code
            elif field == "message":
                row[field] = f"Cannot assign value for {code} in branch {i % 7}"
            elif field == "text":
                row[field] = f"matched call to oldName with argument {i % 9}"
            elif field == "id":
                row[field] = f"@c{i:03d}"
            elif field == "type":
                row[field] = dataset.kind
            elif field == "state":
                row[field] = ["active", "covered", "stale"][i % 3]
            elif field == "digest":
                row[field] = f"d{i:06x}"
            elif field == "summary":
                row[field] = f"capsule for {path}, touched by turn {i % 11}"
            elif field == "symbol":
                row[field] = "getDisplayName"
            elif field == "context":
                row[field] = f"const value{i % 4} = getDisplayName(user{i % 6});"
        rows.append(row)
    return rows


def intern_values(rows: list[dict[str, object]]) -> tuple[dict[str, int], list[list[object]]]:
    strings: dict[str, int] = {}
    encoded: list[list[object]] = []
    for row in rows:
        out: list[object] = []
        for value in row.values():
            if isinstance(value, str) and (value.startswith("src/") or value.startswith("E") or value in {"error", "warning", "active", "covered", "stale", "getDisplayName"}):
                if value not in strings:
                    strings[value] = len(strings)
                out.append(strings[value])
            else:
                out.append(value)
        encoded.append(out)
    return strings, encoded


def render(dataset: Dataset, shape: Shape) -> str:
    rows = make_rows(dataset)
    fields = list(dataset.fields)
    if shape.name == "pretty_object_json":
        return json.dumps(rows, indent=2)
    if shape.name == "minified_object_json":
        return json.dumps(rows, separators=(",", ":"))
    if shape.name == "tuple_rows_legend":
        return json.dumps({"cols": fields, "rows": [[row[field] for field in fields] for row in rows]}, separators=(",", ":"))
    if shape.name == "columnar_arrays":
        return json.dumps({"cols": fields, "data": {field: [row[field] for row in rows] for field in fields}}, separators=(",", ":"))
    if shape.name == "interned_tuple_rows":
        strings, encoded = intern_values(rows)
        return json.dumps({"cols": fields, "s": {str(v): k for k, v in strings.items()}, "rows": encoded}, separators=(",", ":"))
    if shape.name == "terse_lines":
        lines = ["|".join(fields)]
        for row in rows:
            lines.append("|".join(str(row[field]) for field in fields))
        return "\n".join(lines)
    raise ValueError(shape.name)


def retry(dataset: Dataset, shape: Shape, visible_tokens: int) -> float:
    row_pressure = max(0, dataset.rows - 50) / 500
    field_pressure = max(0, len(dataset.fields) - 4) * 0.01
    compact_pressure = max(0, 800 - visible_tokens) / 20_000
    return round(min(0.60, shape.parser_risk + shape.missing_field_risk + row_pressure + field_pressure + compact_pressure), 3)


def dollars(visible: int, rent: int, retry_turns: float) -> float:
    uncached = visible
    cached = rent + retry_turns * RETRY_TURN_TOKENS
    return round(uncached / 1_000_000 * INPUT_PER_MTOK + cached / 1_000_000 * CACHED_PER_MTOK, 6)


def simulate() -> list[Row]:
    rows: list[Row] = []
    for dataset in DATASETS:
        local: list[Row] = []
        for shape in SHAPES:
            visible = tok(render(dataset, shape))
            rent = int(visible * shape.future_visibility_factor * FUTURE_TURNS)
            expected_retry = retry(dataset, shape, visible)
            effective = visible + rent // 10 + int(expected_retry * RETRY_TURN_TOKENS // 10)
            local.append(Row(dataset.name, shape.name, visible, rent, expected_retry, effective, dollars(visible, rent, expected_retry), "", ""))
        best = min(row.dollars for row in local)
        qualified = [row for row in local if row.expected_retry_turns <= 0.25] or local
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
    path.write_text(json.dumps({"datasets": [asdict(d) for d in DATASETS], "shapes": [asdict(s) for s in SHAPES], "rows": [asdict(r) for r in rows]}, indent=2))


def write_md(path: Path, rows: list[Row]) -> None:
    cost_wins: dict[str, int] = {}
    quality_wins: dict[str, int] = {}
    for row in rows:
        if row.winner:
            cost_wins[row.shape] = cost_wins.get(row.shape, 0) + 1
        if row.quality_winner:
            quality_wins[row.shape] = quality_wins.get(row.shape, 0) + 1

    lines = [
        "# Schema-shape simulation",
        "",
        "Question: when do tuple/columnar/legend formats beat object JSON for repeated tool rows?",
        "",
        "## Shapes",
        "",
        "| shape | description |",
        "|---|---|",
    ]
    for shape in SHAPES:
        lines.append(f"| {shape.name} | {shape.description} |")
    lines += [
        "",
        "## Winner counts",
        "",
        "| shape | cost wins | quality-gated wins |",
        "|---|---:|---:|",
    ]
    for name in sorted(set(cost_wins) | set(quality_wins)):
        lines.append(f"| {name} | {cost_wins.get(name, 0)} | {quality_wins.get(name, 0)} |")
    lines += [
        "",
        "## Dataset detail",
        "",
        "| dataset | shape | visible | future rent | retry turns | dollars | flags |",
        "|---|---|---:|---:|---:|---:|---|",
    ]
    for dataset in DATASETS:
        for row in sorted([r for r in rows if r.dataset == dataset.name], key=lambda r: r.dollars):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag)
            lines.append(f"| {row.dataset} | {row.shape} | {row.visible_tokens:,} | {row.future_rent_tokens:,} | {row.expected_retry_turns:.2f} | ${row.dollars:.4f} | {flags} |")
    lines += [
        "",
        "## Takeaways",
        "",
        "- Object JSON is fine for tiny outputs but loses fast because field names repeat every row.",
        "- Tuple rows with a legend are the best default for medium repeated rows: compact without too much parser weirdness.",
        "- Interned tuple rows win when paths/status/codes repeat heavily.",
        "- Columnar arrays can be smaller, but row reconstruction risk makes them a specialized format, not default.",
        "- Terse lines are cheap-looking but have too much missing-field ambiguity for high-stakes tool output.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Schema-shape simulation</title><script src=\"https://cdn.tailwindcss.com\"></script></head><body class=\"bg-zinc-950 text-zinc-100\"><main class=\"mx-auto max-w-6xl p-8\"><pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre></main></body></html>""")


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    rows = simulate()
    md_path = REPORT_DIR / "schema-shape-sim.md"
    json_path = REPORT_DIR / "schema-shape-sim.json"
    csv_path = REPORT_DIR / "schema-shape-sim.csv"
    html_path = REPORT_DIR / "schema-shape-sim.html"
    write_md(md_path, rows)
    write_json(json_path, rows)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
