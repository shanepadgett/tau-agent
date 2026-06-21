#!/usr/bin/env python3
"""Compare edit/addressing encodings across realistic mutation fixtures."""

from __future__ import annotations

import csv
import hashlib
import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

REPORT_DIR = Path("docs/research/agent-runtime/runs/encoding-size-sim")
CHARS_PER_TOKEN = 4
INPUT_PER_MTOK = 3.00
CACHED_INPUT_PER_MTOK = 0.30
OUTPUT_PER_MTOK = 15.00
EXTRA_RETRY_TURN_INPUT = 80_000
EXTRA_RETRY_TURN_OUTPUT = 650
FUTURE_TURNS = 6


def tokens(text: str) -> int:
    return max(1, (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN)


def handle_id(path: str) -> int:
    return int(hashlib.sha1(path.encode()).hexdigest()[:6], 16) % 997


@dataclass(frozen=True)
class Edit:
    path: str
    start: int
    end: int
    old: str
    new: str
    symbol: str = ""


@dataclass(frozen=True)
class Fixture:
    name: str
    description: str
    file_tokens: int
    visible_range_tokens: int
    edits: tuple[Edit, ...]
    files_touched: int
    duplicate_risk: float
    stale_risk: float
    semantic: bool = False
    full_rewrite: bool = False


@dataclass(frozen=True)
class Encoding:
    name: str
    description: str
    supports_semantic: bool
    requires_visible_hashes: bool
    uses_hidden_snapshot: bool
    supports_batch: bool
    terse: bool
    base_retry: float
    stale_multiplier: float
    duplicate_multiplier: float
    semantic_multiplier: float


@dataclass
class Row:
    fixture: str
    encoding: str
    read_visible_tokens: int
    mutation_input_tokens: int
    mutation_output_tokens: int
    future_visible_rent_tokens: int
    hidden_bytes: int
    expected_retry_turns: float
    effective_tokens: int
    dollars: float
    winner: str
    quality_winner: str


@dataclass
class FixtureSummary:
    fixture: str
    winner: str
    quality_winner: str
    winner_dollars: float
    quality_dollars: float


ENCODINGS = [
    Encoding("exact_old_string", "current exact old/new string edit; repeats old text", False, False, False, False, False, 0.030, 1.50, 2.20, 2.00),
    Encoding("apply_patch", "multi-file patch/diff with context lines", False, False, False, True, False, 0.035, 1.25, 1.55, 1.80),
    Encoding("visible_hashline", "read lines as LINE:HASH|content; edits address hashes visibly", False, True, False, True, True, 0.020, 0.90, 0.70, 1.70),
    Encoding("hidden_handle_tuple", "plain read plus hidden snapshot handle; compact tuple ops; stale digest fails tight", False, False, True, True, True, 0.015, 3.50, 0.45, 1.50),
    Encoding("verbose_json_handle", "hidden handle but verbose JSON object ops; stale digest fails tight", False, False, True, True, False, 0.017, 3.50, 0.48, 1.50),
    Encoding("whole_file_write", "replace whole file content", False, False, False, False, False, 0.020, 0.80, 0.90, 1.80),
    Encoding("lsp_command", "semantic LSP rename/organize command", True, False, True, True, True, 0.010, 0.35, 0.25, 0.30),
]


def make_old(label: str, lines: int) -> str:
    return "\n".join(f"  const {label}{i} = source.{label}{i};" for i in range(1, lines + 1))


def make_new(label: str, lines: int) -> str:
    return "\n".join(f"  const {label}{i} = target.{label}{i};" for i in range(1, lines + 1))


def fixtures() -> list[Fixture]:
    return [
        Fixture("single_line", "one small owned-file replacement", 1_800, 900, (
            Edit("src/user.ts", 37, 37, "  return user.name;", "  return user.profile.name;"),
        ), 1, 0.10, 0.05),
        Fixture("three_edits_one_file", "three separated edits in one file", 2_600, 1_600, (
            Edit("src/config.ts", 12, 12, "const retries = 1;", "const retries = 2;"),
            Edit("src/config.ts", 34, 34, "timeoutMs: 5000,", "timeoutMs: 8000,"),
            Edit("src/config.ts", 77, 77, "debug: true,", "debug: false,"),
        ), 1, 0.18, 0.08),
        Fixture("range_replacement", "replace one medium function body", 4_800, 2_400, (
            Edit("src/auth.ts", 40, 58, make_old("auth", 19), make_new("auth", 14)),
        ), 1, 0.22, 0.10),
        Fixture("duplicate_lines", "edit repeated identical guard lines", 3_200, 1_900, (
            Edit("src/router.ts", 44, 44, "if (!ctx.user) return null;", "if (!ctx.user) throw new AuthError();"),
            Edit("src/router.ts", 91, 91, "if (!ctx.user) return null;", "if (!ctx.user) throw new AuthError();"),
        ), 1, 0.85, 0.10),
        Fixture("full_config_rewrite", "rewrite a small generated config by full content", 1_200, 1_200, (
            Edit("config/tool.json", 1, 80, make_old("cfg", 80), make_new("cfg", 78)),
        ), 1, 0.05, 0.08, full_rewrite=True),
        Fixture("refactor_three_files", "rename API usage across three files", 7_500, 4_000, (
            Edit("src/api.ts", 21, 21, "export function getUserName", "export function getDisplayName", "getUserName"),
            Edit("src/view.ts", 55, 55, "getUserName(user)", "getDisplayName(user)", "getUserName"),
            Edit("src/view.test.ts", 88, 88, "getUserName(fake)", "getDisplayName(fake)", "getUserName"),
        ), 3, 0.35, 0.12, semantic=True),
        Fixture("refactor_ten_files", "same semantic rename across ten files", 24_000, 10_000, tuple(
            Edit(f"src/feature/file{i}.ts", 20 + i, 20 + i, "getUserName(user)", "getDisplayName(user)", "getUserName")
            for i in range(1, 11)
        ), 10, 0.45, 0.15, semantic=True),
        Fixture("small_edits_25_files", "one boring import/path edit in 25 files", 36_000, 16_000, tuple(
            Edit(f"src/routes/r{i}.ts", 3, 3, "import { oldThing } from '../old';", "import { newThing } from '../new';")
            for i in range(1, 26)
        ), 25, 0.25, 0.18),
        Fixture("stale_moved_block", "read got stale and block moved before edit", 5_500, 2_700, (
            Edit("src/state.ts", 70, 90, make_old("state", 21), make_new("state", 20)),
        ), 1, 0.30, 0.75),
        Fixture("lsp_rename_workspace", "true semantic workspace rename", 30_000, 12_000, (
            Edit("src/domain/user.ts", 18, 18, "interface UserProfile", "interface AccountProfile", "UserProfile"),
        ), 18, 0.60, 0.12, semantic=True),
    ]


def line_prefix_tokens(fixture: Fixture) -> int:
    # Visible hashline tax: roughly `123:abc|` per visible line. Estimate from range density.
    estimated_lines = max(1, fixture.visible_range_tokens // 8)
    return estimated_lines * tokens("123:abc|")


def read_tokens(fixture: Fixture, encoding: Encoding) -> int:
    if encoding.name == "lsp_command" and fixture.semantic:
        return max(600, fixture.files_touched * 120)
    if fixture.full_rewrite and encoding.name == "whole_file_write":
        return 80
    base = fixture.visible_range_tokens
    if encoding.requires_visible_hashes:
        return base + line_prefix_tokens(fixture)
    if encoding.uses_hidden_snapshot:
        return base + 24
    return base


def exact_mutation_tokens(fixture: Fixture) -> int:
    total = tokens("edit ")
    for edit in fixture.edits:
        total += tokens(edit.path) + tokens(edit.old) + tokens(edit.new) + 18
    if len(fixture.edits) > 1:
        total += len(fixture.edits) * 10
    return total


def patch_mutation_tokens(fixture: Fixture) -> int:
    total = 0
    for edit in fixture.edits:
        context = min(tokens(edit.old), 80) + 24
        total += tokens(f"*** Update File: {edit.path}\n@@\n") + tokens(edit.old) + tokens(edit.new) + context
    return total + 20


def hashline_mutation_tokens(fixture: Fixture) -> int:
    total = 20
    for edit in fixture.edits:
        total += tokens(f"{edit.path}:{edit.start}:abc") + tokens(edit.new) + 8
    return total


def tuple_mutation_tokens(fixture: Fixture) -> int:
    total = 14
    for edit in fixture.edits:
        span = f"['@{handle_id(edit.path)}',{edit.start},{edit.end},"
        total += tokens(span) + tokens(edit.new) + 4
    return total


def verbose_json_tokens(fixture: Fixture) -> int:
    payload = {
        "edits": [
            {
                "handle": f"file-{handle_id(edit.path)}",
                "path": edit.path,
                "operation": "replaceRange",
                "startLine": edit.start,
                "endLineInclusive": edit.end,
                "replacement": edit.new,
            }
            for edit in fixture.edits
        ]
    }
    return tokens(json.dumps(payload, separators=(",", ":")))


def whole_write_tokens(fixture: Fixture) -> int:
    if fixture.full_rewrite:
        return fixture.file_tokens + 40
    changed = sum(tokens(edit.new) for edit in fixture.edits)
    return max(fixture.file_tokens + 40, changed + fixture.file_tokens // 2)


def lsp_tokens(fixture: Fixture) -> int:
    if not fixture.semantic:
        return 999_999
    symbol = next((edit.symbol for edit in fixture.edits if edit.symbol), "symbol")
    return tokens(json.dumps({"op": "rename", "symbol": symbol, "newName": "getDisplayName"}, separators=(",", ":"))) + 30


def mutation_tokens(fixture: Fixture, encoding: Encoding) -> int:
    if encoding.name == "exact_old_string":
        return exact_mutation_tokens(fixture)
    if encoding.name == "apply_patch":
        return patch_mutation_tokens(fixture)
    if encoding.name == "visible_hashline":
        return hashline_mutation_tokens(fixture)
    if encoding.name == "hidden_handle_tuple":
        return tuple_mutation_tokens(fixture)
    if encoding.name == "verbose_json_handle":
        return verbose_json_tokens(fixture)
    if encoding.name == "whole_file_write":
        return whole_write_tokens(fixture)
    if encoding.name == "lsp_command":
        return lsp_tokens(fixture)
    raise ValueError(encoding.name)


def mutation_output_tokens(fixture: Fixture, encoding: Encoding) -> int:
    if encoding.name == "whole_file_write":
        if fixture.full_rewrite:
            return 160
        return min(fixture.file_tokens, 5_000)
    if encoding.name == "lsp_command" and fixture.semantic:
        return 180 + fixture.files_touched * 45
    if encoding.uses_hidden_snapshot:
        return 140 + fixture.files_touched * 35
    return 220 + fixture.files_touched * 45


def hidden_bytes(fixture: Fixture, encoding: Encoding) -> int:
    if encoding.name == "lsp_command" and not fixture.semantic:
        return 0
    if encoding.uses_hidden_snapshot:
        return fixture.file_tokens * CHARS_PER_TOKEN
    return 0


def retry_turns(fixture: Fixture, encoding: Encoding) -> float:
    if encoding.name == "lsp_command" and not fixture.semantic:
        return 10.0
    retry = encoding.base_retry
    retry += fixture.stale_risk * 0.10 * encoding.stale_multiplier
    retry += fixture.duplicate_risk * 0.08 * encoding.duplicate_multiplier
    if fixture.semantic:
        retry += 0.12 * encoding.semantic_multiplier
    if fixture.full_rewrite and encoding.name == "whole_file_write":
        retry *= 0.55
    if fixture.files_touched > 8 and not encoding.supports_batch:
        retry += 0.08
    return round(min(0.95, retry), 3)


def quality_ok(fixture: Fixture, encoding: Encoding, expected_retry: float) -> bool:
    if encoding.name == "whole_file_write" and not fixture.full_rewrite and fixture.file_tokens > 8_000:
        return False
    if encoding.name == "exact_old_string" and fixture.duplicate_risk > 0.60:
        return False
    if encoding.name == "apply_patch" and fixture.duplicate_risk > 0.80:
        return False
    if encoding.name == "lsp_command" and not fixture.semantic:
        return False
    if fixture.semantic and encoding.name != "lsp_command" and fixture.files_touched >= 10:
        return False
    return expected_retry <= 0.45


def dollars(read: int, mutation: int, output: int, rent: int, retry: float) -> float:
    uncached = read + mutation + output + retry * EXTRA_RETRY_TURN_OUTPUT
    cached = rent + retry * EXTRA_RETRY_TURN_INPUT
    return round(uncached / 1_000_000 * INPUT_PER_MTOK + cached / 1_000_000 * CACHED_INPUT_PER_MTOK, 6)


def simulate() -> tuple[list[Row], list[FixtureSummary]]:
    rows: list[Row] = []
    summaries: list[FixtureSummary] = []
    for fixture in fixtures():
        fixture_rows: list[Row] = []
        for encoding in ENCODINGS:
            read = read_tokens(fixture, encoding)
            mutation = mutation_tokens(fixture, encoding)
            output = mutation_output_tokens(fixture, encoding)
            if mutation >= 999_999:
                read = 999_999
                output = 999_999
            rent_visible = max(0, read + output - (24 if encoding.uses_hidden_snapshot else 0))
            rent = rent_visible * FUTURE_TURNS
            retry = retry_turns(fixture, encoding)
            effective = read + mutation + output + rent // 10 + int(retry * (EXTRA_RETRY_TURN_INPUT // 10 + EXTRA_RETRY_TURN_OUTPUT))
            row = Row(
                fixture=fixture.name,
                encoding=encoding.name,
                read_visible_tokens=read,
                mutation_input_tokens=mutation,
                mutation_output_tokens=output,
                future_visible_rent_tokens=rent,
                hidden_bytes=hidden_bytes(fixture, encoding),
                expected_retry_turns=retry,
                effective_tokens=effective,
                dollars=dollars(read, mutation, output, rent, retry),
                winner="",
                quality_winner="",
            )
            fixture_rows.append(row)
        best = min(row.dollars for row in fixture_rows)
        quality_rows = [row for row in fixture_rows if quality_ok(fixture, next(enc for enc in ENCODINGS if enc.name == row.encoding), row.expected_retry_turns)]
        quality_best = min(row.dollars for row in quality_rows)
        for row in fixture_rows:
            if row.dollars == best:
                row.winner = "winner"
            if row.dollars == quality_best and row in quality_rows:
                row.quality_winner = "quality_winner"
        winner = next(row for row in fixture_rows if row.winner)
        quality = next(row for row in fixture_rows if row.quality_winner)
        summaries.append(FixtureSummary(fixture.name, winner.encoding, quality.encoding, winner.dollars, quality.dollars))
        rows.extend(fixture_rows)
    return rows, summaries


def rows_for(rows: list[Row], fixture: str) -> list[Row]:
    return sorted([row for row in rows if row.fixture == fixture], key=lambda row: row.dollars)


def write_csv(path: Path, rows: list[Row]) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def write_json(path: Path, rows: list[Row], summaries: list[FixtureSummary]) -> None:
    path.write_text(json.dumps({
        "assumptions": {
            "chars_per_token": CHARS_PER_TOKEN,
            "future_turns": FUTURE_TURNS,
            "input_per_mtok": INPUT_PER_MTOK,
            "cached_input_per_mtok": CACHED_INPUT_PER_MTOK,
            "extra_retry_turn_input": EXTRA_RETRY_TURN_INPUT,
        },
        "encodings": [asdict(encoding) for encoding in ENCODINGS],
        "fixtures": [asdict(fixture) for fixture in fixtures()],
        "summaries": [asdict(summary) for summary in summaries],
        "rows": [asdict(row) for row in rows],
    }, indent=2))


def write_markdown(path: Path, rows: list[Row], summaries: list[FixtureSummary]) -> None:
    cost_wins: dict[str, int] = {}
    quality_wins: dict[str, int] = {}
    for row in rows:
        if row.winner:
            cost_wins[row.encoding] = cost_wins.get(row.encoding, 0) + 1
        if row.quality_winner:
            quality_wins[row.encoding] = quality_wins.get(row.encoding, 0) + 1

    lines = [
        "# Encoding-size simulation",
        "",
        "Question: which edit/addressing encoding minimizes total task cost without buying wrong edits?",
        "",
        "This compares read-visible overhead, mutation payload size, future visible rent, hidden snapshot bytes, and expected retry turns. Token counts are estimated from generated fixture payloads, not hand-waved constants.",
        "",
        "## Encodings",
        "",
        "| encoding | shape |",
        "|---|---|",
    ]
    for encoding in ENCODINGS:
        lines.append(f"| {encoding.name} | {encoding.description} |")

    lines += [
        "",
        "## Winner counts",
        "",
        "| encoding | cost wins | quality-gated wins |",
        "|---|---:|---:|",
    ]
    all_names = sorted(set(cost_wins) | set(quality_wins))
    for name in all_names:
        lines.append(f"| {name} | {cost_wins.get(name, 0)} | {quality_wins.get(name, 0)} |")

    lines += [
        "",
        "## Fixture winners",
        "",
        "| fixture | cost winner | quality winner | cost $ | quality $ |",
        "|---|---|---|---:|---:|",
    ]
    for summary in summaries:
        lines.append(f"| {summary.fixture} | {summary.winner} | {summary.quality_winner} | ${summary.winner_dollars:.4f} | ${summary.quality_dollars:.4f} |")

    for fixture_name in ["duplicate_lines", "refactor_ten_files", "small_edits_25_files", "stale_moved_block"]:
        lines += [
            "",
            f"## Detail: {fixture_name}",
            "",
            "| encoding | read | mutation | output | future rent | hidden bytes | retry turns | dollars | flags |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---|",
        ]
        for row in rows_for(rows, fixture_name):
            flags = ", ".join(flag for flag in [row.winner, row.quality_winner] if flag) or ""
            lines.append(f"| {row.encoding} | {row.read_visible_tokens:,} | {row.mutation_input_tokens:,} | {row.mutation_output_tokens:,} | {row.future_visible_rent_tokens:,} | {row.hidden_bytes:,} | {row.expected_retry_turns:.2f} | ${row.dollars:.4f} | {flags} |")

    lines += [
        "",
        "## Takeaways",
        "",
        "- Hidden handle tuples dominate ordinary text edits: low read tax, tiny mutation payloads, low duplicate/stale retry risk.",
        "- Visible hashlines are a useful stateless fallback, but their per-line read rent compounds across future turns.",
        "- `apply_patch` remains table stakes for compatibility and can be competitive on moved-block retries, but repeats old/context text and needs duplicate/stale safeguards.",
        "- Whole-file write is fine for tiny config rewrites; bad default for large or multi-file source edits.",
        "- LSP command wins semantic workspace refactors. Do not make text edit syntax compete with rename/organize-import operations.",
        "- V1 hidden-handle policy should fail tight on stale digest. Relocation is a separate retry-cost test, not assumed here.",
    ]
    path.write_text("\n".join(lines))


def write_html(md_path: Path, html_path: Path) -> None:
    body = html.escape(md_path.read_text())
    html_path.write_text(f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>Encoding-size simulation</title>
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
    rows, summaries = simulate()
    md_path = REPORT_DIR / "encoding-size-sim.md"
    json_path = REPORT_DIR / "encoding-size-sim.json"
    csv_path = REPORT_DIR / "encoding-size-sim.csv"
    html_path = REPORT_DIR / "encoding-size-sim.html"
    write_markdown(md_path, rows, summaries)
    write_json(json_path, rows, summaries)
    write_csv(csv_path, rows)
    write_html(md_path, html_path)
    for report in [md_path, json_path, csv_path, html_path]:
        print(report)


if __name__ == "__main__":
    main()
