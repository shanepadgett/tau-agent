#!/usr/bin/env python3
"""Profile repo file sizes for context-pack/read-policy research."""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import median
from typing import Iterable

DEFAULT_ROOTS = [
    ("pi", "/Users/shanepadgett/.local/share/tau-agent/references/pi"),
    ("codex", "/Users/shanepadgett/.local/share/tau-agent/references/codex"),
    ("opencode", "/Users/shanepadgett/.local/share/tau-agent/references/opencode"),
    ("tau-agent", "."),
]

REPORT_DIR = Path("docs/plans/fs-tool-research/reports")
TEXT_EXTS = {
    ".bat", ".c", ".cc", ".cfg", ".cjs", ".clj", ".cpp", ".css", ".csv", ".cts",
    ".d.ts", ".dart", ".diff", ".dockerfile", ".env", ".go", ".graphql", ".h", ".hpp",
    ".html", ".java", ".js", ".json", ".jsonc", ".jsx", ".kt", ".lock", ".lua", ".mjs",
    ".md", ".mdx", ".mts", ".nix", ".patch", ".php", ".pl", ".prisma", ".proto",
    ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte", ".swift", ".toml",
    ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml", ".zig",
}
CONFIG_NAMES = {
    ".env", ".env.example", ".gitignore", ".npmrc", ".prettierrc", "dockerfile", "makefile",
    "package.json", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "tsconfig.json", "vite.config.ts",
    "eslint.config.js", "eslint.config.mjs", "biome.json", "ruff.toml", "pyproject.toml", "cargo.toml",
}
VENDOR_PARTS = {"node_modules", "vendor", "third_party", ".git", ".next", ".turbo", ".cache", ".pnpm-store"}
GENERATED_PARTS = {"dist", "build", "coverage", "out", "target", "generated", "gen", ".vercel"}
ASSET_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".pdf", ".mp4", ".mov", ".woff", ".woff2", ".ttf"}
SOURCE_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".rb", ".swift", ".kt", ".zig", ".c", ".cc", ".cpp", ".h", ".hpp"}
DOC_EXTS = {".md", ".mdx", ".txt", ".rst", ".adoc"}
TEST_HINTS = {"test", "tests", "spec", "specs", "__tests__", "fixtures", "fixture"}
PACK_LIMITS = [15_000, 25_000, 40_000, 80_000]
WHOLE_READ_LIMITS = [1_000, 2_000, 3_000, 5_000, 8_000, 12_000]


@dataclass
class FileRow:
    repo: str
    path: str
    bucket: str
    bytes: int
    lines: int
    tokens_4: int
    tokens_35: int


def run_git_files(root: Path) -> list[str] | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    if not result.stdout:
        return None
    return [p.decode("utf-8", "replace") for p in result.stdout.split(b"\0") if p]


def walk_files(root: Path) -> list[str]:
    out: list[str] = []
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in VENDOR_PARTS and d != ".git"]
        for file in files:
            p = Path(base, file)
            out.append(str(p.relative_to(root)))
    return out


def classify(path: str) -> str:
    p = Path(path)
    lower = path.lower()
    parts = {part.lower() for part in p.parts}
    name = p.name.lower()
    suffixes = [s.lower() for s in p.suffixes]
    ext = suffixes[-1] if suffixes else ""

    if parts & VENDOR_PARTS:
        return "vendor"
    if ".pi" in parts and "extensions" in parts and ext in SOURCE_EXTS:
        return "source"
    if parts & TEST_HINTS or ".test." in lower or ".spec." in lower:
        return "test"
    if parts & GENERATED_PARTS or "generated" in name or name.endswith(".snap") or name.endswith(".schemas.json") or name == "openapi.json":
        return "generated"
    if ext in ASSET_EXTS:
        return "asset"
    if name in CONFIG_NAMES or any(part.startswith(".") for part in p.parts[:-1]) or ext in {".toml", ".yaml", ".yml", ".json", ".jsonc", ".lock"}:
        return "config"
    if ext in DOC_EXTS or "docs" in parts or "documentation" in parts:
        return "docs"
    if ext in SOURCE_EXTS:
        return "source"
    if ext in TEXT_EXTS:
        return "text-other"
    return "binary-other"


def is_probably_text(data: bytes, path: str) -> bool:
    if b"\0" in data[:4096]:
        return False
    lower = Path(path).name.lower()
    ext = "".join(Path(path).suffixes[-1:]).lower()
    return ext in TEXT_EXTS or lower in CONFIG_NAMES


def profile_repo(label: str, root_text: str) -> list[FileRow]:
    root = Path(root_text).expanduser().resolve()
    paths = run_git_files(root) or walk_files(root)
    rows: list[FileRow] = []
    for rel in paths:
        full = root / rel
        try:
            data = full.read_bytes()
        except OSError:
            continue
        size = len(data)
        bucket = classify(rel)
        if is_probably_text(data, rel):
            lines = data.count(b"\n") + (0 if not data or data.endswith(b"\n") else 1)
            chars = len(data.decode("utf-8", "replace"))
            tokens_4 = round(chars / 4)
            tokens_35 = round(chars / 3.5)
        else:
            lines = 0
            tokens_4 = 0
            tokens_35 = 0
        rows.append(FileRow(label, rel, bucket, size, lines, tokens_4, tokens_35))
    return rows


def percentile(values: list[int], pct: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    idx = round((len(ordered) - 1) * pct)
    return ordered[idx]


def summarize_bucket(rows: list[FileRow]) -> dict[str, int | float]:
    tokens = [r.tokens_4 for r in rows if r.tokens_4 > 0]
    sizes = [r.bytes for r in rows]
    return {
        "files": len(rows),
        "text_files": len(tokens),
        "bytes": sum(sizes),
        "tokens_4": sum(r.tokens_4 for r in rows),
        "lines": sum(r.lines for r in rows),
        "p50_tokens": int(median(tokens)) if tokens else 0,
        "p75_tokens": percentile(tokens, 0.75),
        "p90_tokens": percentile(tokens, 0.90),
        "p95_tokens": percentile(tokens, 0.95),
        "max_tokens": max(tokens) if tokens else 0,
    }


def repo_summary(label: str, rows: list[FileRow]) -> dict[str, object]:
    by_bucket: dict[str, list[FileRow]] = defaultdict(list)
    for row in rows:
        by_bucket[row.bucket].append(row)

    owned = [r for r in rows if r.bucket in {"source", "test", "docs", "config", "text-other"} and r.tokens_4 > 0]
    pack_capacity = {}
    for limit in PACK_LIMITS:
        ordered = sorted(owned, key=lambda r: r.tokens_4)
        total = 0
        count = 0
        for row in ordered:
            if total + row.tokens_4 > limit:
                break
            total += row.tokens_4
            count += 1
        pack_capacity[str(limit)] = {"smallest_first_files": count, "tokens": total}

    thresholds = {}
    for limit in WHOLE_READ_LIMITS:
        candidates = [r for r in owned if r.tokens_4 <= limit]
        thresholds[str(limit)] = {
            "files": len(candidates),
            "share_of_owned_text_files": round(len(candidates) / len(owned), 4) if owned else 0,
        }

    return {
        "repo": label,
        "totals": summarize_bucket(rows),
        "buckets": {bucket: summarize_bucket(bucket_rows) for bucket, bucket_rows in sorted(by_bucket.items())},
        "whole_read_thresholds": thresholds,
        "pack_capacity": pack_capacity,
        "largest_text_files": [asdict(r) for r in sorted([r for r in rows if r.tokens_4 > 0], key=lambda r: r.tokens_4, reverse=True)[:20]],
    }


def write_csv(rows: list[FileRow], path: Path) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(rows[0]).keys()) if rows else ["repo", "path", "bucket", "bytes", "lines", "tokens_4", "tokens_35"])
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def write_markdown(summaries: list[dict[str, object]], path: Path) -> None:
    lines = ["# Repo size profile", "", "Token estimate: `chars / 4`. Repos reported separately; do not blend means.", ""]
    for summary in summaries:
        repo = summary["repo"]
        totals = summary["totals"]
        assert isinstance(totals, dict)
        lines += [f"## {repo}", ""]
        lines += [
            f"Files: {totals['files']:,}; text files: {totals['text_files']:,}; estimated tokens: {totals['tokens_4']:,}; bytes: {totals['bytes']:,}.",
            "",
            "### Buckets",
            "",
            "| bucket | files | text | tokens | p50 | p90 | p95 | max |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
        buckets = summary["buckets"]
        assert isinstance(buckets, dict)
        for bucket, stats_obj in buckets.items():
            stats = stats_obj
            assert isinstance(stats, dict)
            lines.append(f"| {bucket} | {stats['files']:,} | {stats['text_files']:,} | {stats['tokens_4']:,} | {stats['p50_tokens']:,} | {stats['p90_tokens']:,} | {stats['p95_tokens']:,} | {stats['max_tokens']:,} |")
        lines += ["", "### Whole-read candidate thresholds", "", "| limit tokens | files | owned text share |", "|---:|---:|---:|"]
        thresholds = summary["whole_read_thresholds"]
        assert isinstance(thresholds, dict)
        for limit, stats_obj in thresholds.items():
            stats = stats_obj
            assert isinstance(stats, dict)
            lines.append(f"| {int(limit):,} | {stats['files']:,} | {stats['share_of_owned_text_files']:.1%} |")
        lines += ["", "### Pack capacity, smallest owned text files first", "", "| pack tokens | files fit | used tokens |", "|---:|---:|---:|"]
        packs = summary["pack_capacity"]
        assert isinstance(packs, dict)
        for limit, stats_obj in packs.items():
            stats = stats_obj
            assert isinstance(stats, dict)
            lines.append(f"| {int(limit):,} | {stats['smallest_first_files']:,} | {stats['tokens']:,} |")
        lines += ["", "### Largest text files", "", "| tokens | bucket | path |", "|---:|---|---|"]
        largest = summary["largest_text_files"]
        assert isinstance(largest, list)
        for row_obj in largest[:10]:
            row = row_obj
            assert isinstance(row, dict)
            lines.append(f"| {row['tokens_4']:,} | {row['bucket']} | `{row['path']}` |")
        lines.append("")
    path.write_text("\n".join(lines))


def write_html(markdown_path: Path, html_path: Path) -> None:
    body = markdown_path.read_text().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html_path.write_text(f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>Repo size profile</title>
  <script src=\"https://cdn.tailwindcss.com\"></script>
</head>
<body class=\"bg-zinc-950 text-zinc-100\">
  <main class=\"mx-auto max-w-6xl p-8\">
    <pre class=\"whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-sm leading-6 text-zinc-200\">{body}</pre>
  </main>
</body>
</html>
""")


def parse_roots(values: Iterable[str]) -> list[tuple[str, str]]:
    roots: list[tuple[str, str]] = []
    for value in values:
        if "=" not in value:
            raise SystemExit(f"root must be label=path, got {value!r}")
        label, path = value.split("=", 1)
        roots.append((label, path))
    return roots


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", action="append", default=[], help="label=path. Defaults to pi/codex/opencode/current repo.")
    args = parser.parse_args()
    roots = parse_roots(args.root) if args.root else DEFAULT_ROOTS

    all_rows: list[FileRow] = []
    summaries: list[dict[str, object]] = []
    for label, root in roots:
        rows = profile_repo(label, root)
        all_rows.extend(rows)
        summaries.append(repo_summary(label, rows))

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = REPORT_DIR / "repo-size-profile.csv"
    json_path = REPORT_DIR / "repo-size-profile.json"
    md_path = REPORT_DIR / "repo-size-profile.md"
    html_path = REPORT_DIR / "repo-size-profile.html"

    write_csv(all_rows, csv_path)
    json_path.write_text(json.dumps({"repos": summaries}, indent=2))
    write_markdown(summaries, md_path)
    write_html(md_path, html_path)

    for path in [md_path, json_path, csv_path, html_path]:
        print(path)


if __name__ == "__main__":
    main()
