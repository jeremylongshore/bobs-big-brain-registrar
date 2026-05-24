#!/usr/bin/env python3
"""
validate-frontmatter — custom IS doc-frontmatter validator.

Walks `000-docs/*.md` (and equivalents), parses YAML frontmatter, validates
against the Document Filing Standard v4.3 schema (per `~/000-projects/CLAUDE.md`).

Required fields (always):
    title           — non-empty string

Recommended (warned if missing):
    filing_code     — e.g. "034-AT-NTRP", "035-AT-DECR"
    date            — ISO 8601 (YYYY-MM-DD)
    status          — free-text status string

Per-class strict fields (errored if missing):
    AT-DECR docs    — must have `acting_head_of_board`, `status`
    AT-NTRP docs    — must have `authors`, `cross_repo` if it ends `-thesis.md`

Exit codes:
    0  — all docs valid
    1  — at least one error (CI gate fails)
    2  — config / parse error (CI gate fails — fix the validator)

Usage:
    python3 scripts/validate-frontmatter.py [--root <dir>] [--strict]

--strict  promotes warnings to errors.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml  # PyYAML
except ImportError:
    print("ERROR: PyYAML is required. Install with: pip install pyyaml", file=sys.stderr)
    sys.exit(2)


FRONTMATTER_RE = re.compile(
    r"\A---\s*\n(?P<fm>.*?)\n---\s*\n", re.DOTALL
)

# Class detection from filename.
CLASS_RE = re.compile(r"^(\d{3})-(?P<class>[A-Z]{2}-[A-Z]{4})-")


def detect_class(path: Path) -> str | None:
    """Return the 2-letter+4-letter doc-class code from a filename, or None."""
    match = CLASS_RE.match(path.name)
    return match.group("class") if match else None


def parse_frontmatter(path: Path) -> dict[str, Any] | None:
    """Return parsed YAML frontmatter dict, None if absent, raises on parse error."""
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    if not match:
        return None
    parsed = yaml.safe_load(match.group("fm"))
    if not isinstance(parsed, dict):
        raise ValueError(f"Frontmatter is not a YAML mapping in {path}")
    return parsed


def validate(path: Path, fm: dict[str, Any], strict: bool) -> tuple[list[str], list[str]]:
    """Return (errors, warnings) lists for a single doc."""
    errors: list[str] = []
    warnings: list[str] = []

    # Always required.
    title = fm.get("title")
    if not title or not isinstance(title, str) or not title.strip():
        errors.append("missing or empty `title` field")

    # Recommended.
    if "filing_code" not in fm:
        warnings.append("missing recommended `filing_code` field")
    if "date" not in fm:
        warnings.append("missing recommended `date` field")
    if "status" not in fm:
        warnings.append("missing recommended `status` field")

    # Per-class strict.
    cls = detect_class(path)
    if cls == "AT-DECR":
        if "acting_head_of_board" not in fm:
            errors.append("AT-DECR docs must have `acting_head_of_board`")
        if "status" not in fm:
            errors.append("AT-DECR docs must have `status`")
    elif cls == "AT-NTRP" and path.name.endswith("-thesis.md"):
        if "authors" not in fm:
            errors.append("AT-NTRP thesis docs must have `authors`")
        if "cross_repo" not in fm:
            warnings.append("AT-NTRP thesis docs should have `cross_repo`")

    if strict:
        return errors + warnings, []
    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate IS doc frontmatter.")
    parser.add_argument(
        "--root", default=".", help="Repo root to scan (default: current directory)."
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Promote warnings to errors.",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()

    # Find all candidate doc paths. Primary: 000-docs/. Secondary: top-level *.md.
    candidates: list[Path] = []
    docs_dir = root / "000-docs"
    if docs_dir.is_dir():
        candidates.extend(sorted(docs_dir.glob("**/*.md")))

    # Skip auto-managed directories.
    skip_segments = {"node_modules", "dist", ".audit-harness", "coverage", ".vale", "reports"}
    candidates = [p for p in candidates if not any(s in p.parts for s in skip_segments)]

    if not candidates:
        print("validate-frontmatter: no markdown files found under 000-docs/. Skipping.")
        return 0

    total_errors = 0
    total_warnings = 0
    files_with_no_fm = 0

    for path in candidates:
        rel = path.relative_to(root)
        try:
            fm = parse_frontmatter(path)
        except (yaml.YAMLError, ValueError) as exc:
            print(f"  ERR  {rel}: frontmatter parse failed: {exc}")
            total_errors += 1
            continue

        if fm is None:
            files_with_no_fm += 1
            continue  # Markdown without frontmatter is allowed for non-doc-class files.

        errors, warnings = validate(path, fm, args.strict)
        for msg in errors:
            print(f"  ERR  {rel}: {msg}")
            total_errors += 1
        for msg in warnings:
            print(f"  WARN {rel}: {msg}")
            total_warnings += 1

    print()
    print(f"validate-frontmatter: scanned {len(candidates)} files")
    print(f"  ({files_with_no_fm} had no frontmatter — skipped, not an error)")
    print(f"  errors:   {total_errors}")
    print(f"  warnings: {total_warnings}")

    if total_errors > 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
