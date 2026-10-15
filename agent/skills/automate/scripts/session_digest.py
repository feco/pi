#!/usr/bin/env python3
"""Condense coding-agent session transcripts (JSONL) into a readable timeline.

Prints one line per user message, assistant message, tool call, and failed tool
result. Thinking, system prompts, and successful tool output are dropped.

Without file arguments, finds the most recent sessions for a working directory
in every known harness store (Claude Code and Pi).

Usage:
    session_digest.py [SESSION.jsonl ...] [--recent N] [--cwd DIR] [--all-projects]
                      [--list] [--width N]
"""

import argparse
import json
import os
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

TOOL_CALL_TYPES: frozenset[str] = frozenset({"tool_use", "toolCall"})
TOOL_RESULT_TYPES: frozenset[str] = frozenset({"tool_result", "toolResult"})


def session_roots() -> list[Path]:
    """List the directories where known harnesses store per-project sessions.

    Returns:
        Existing session root directories.
    """
    claude: Path = (
        Path(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude")).expanduser() / "projects"
    )
    pi_agent: Path = Path(
        os.environ.get("PI_CODING_AGENT_DIR", "~/.pi/agent")
    ).expanduser()
    candidates: list[Path] = [claude, pi_agent / "sessions"]
    if "PI_CODING_AGENT_SESSION_DIR" in os.environ:
        candidates.append(Path(os.environ["PI_CODING_AGENT_SESSION_DIR"]).expanduser())
    return [root for root in candidates if root.is_dir()]


def slug(name: str) -> str:
    """Normalize a path or project folder name for comparison.

    Claude Code and Pi both name a project's folder after its working directory,
    with different escaping. Reducing every non-alphanumeric run to one form
    makes the two comparable.

    Args:
        name: A working directory path or a project folder name.

    Returns:
        The normalized name.
    """
    return re.sub(r"[^A-Za-z0-9]", "-", name).strip("-")


def find_sessions(cwd: Path, all_projects: bool) -> list[Path]:
    """Find session transcripts, newest first.

    Args:
        cwd: Working directory whose sessions to find.
        all_projects: Return sessions of every project instead.

    Returns:
        Paths to JSONL transcripts, sorted by modification time, newest first.
    """
    wanted: str = slug(str(cwd.resolve()))
    found: list[Path] = []
    for root in session_roots():
        for project in root.iterdir():
            if project.is_dir() and (all_projects or slug(project.name) == wanted):
                found.extend(project.glob("*.jsonl"))
    return sorted(found, key=lambda path: path.stat().st_mtime, reverse=True)


def shorten(text: str, width: int) -> str:
    """Collapse whitespace and truncate text to a maximum width.

    Args:
        text: Text to shorten.
        width: Maximum number of characters to keep.

    Returns:
        The single-line, truncated text.
    """
    flat: str = " ".join(text.split())
    return flat if len(flat) <= width else flat[: width - 1] + "…"


def text_of(content: Any) -> str:
    """Extract the plain text from a message or tool-result content field.

    Args:
        content: A string or a list of content blocks.

    Returns:
        The concatenated text blocks.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            str(block.get("text", ""))
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


def describe_call(name: str, args: Any) -> str:
    """Summarize a tool call by its most telling argument.

    Args:
        name: Tool name.
        args: Tool arguments.

    Returns:
        A short description such as ``bash: git status``.
    """
    if isinstance(args, dict):
        for key in (
            "command",
            "file_path",
            "path",
            "pattern",
            "query",
            "url",
            "skill",
            "description",
        ):
            if key in args:
                return f"{name}: {args[key]}"
    return f"{name}: {json.dumps(args)}"


def entry_lines(entry: dict[str, Any], width: int) -> Iterator[str]:
    """Yield timeline lines for one transcript entry.

    Args:
        entry: One parsed JSONL entry.
        width: Maximum characters per line.

    Yields:
        Formatted timeline lines.
    """
    message: Any = entry.get("message")
    if not isinstance(message, dict):
        return
    role: str = str(message.get("role", entry.get("type", "")))
    if role == "system":
        return
    prefix: str = "  (sub-agent) " if entry.get("isSidechain") else ""
    content: Any = message.get("content")

    if role == "toolResult":
        if message.get("isError"):
            yield prefix + shorten(
                f"[error] {message.get('toolName', '')}: {text_of(content)}", width
            )
        return
    if isinstance(content, str):
        if content.strip():
            yield prefix + shorten(f"[{role}] {content}", width)
        return
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        kind: str = str(block.get("type", ""))
        if kind == "text" and str(block.get("text", "")).strip():
            yield prefix + shorten(f"[{role}] {block['text']}", width)
        elif kind in TOOL_CALL_TYPES:
            args: Any = block.get("input", block.get("arguments"))
            yield prefix + shorten(
                f"[tool] {describe_call(str(block.get('name', '')), args)}", width
            )
        elif kind in TOOL_RESULT_TYPES and block.get("is_error"):
            yield prefix + shorten(f"[error] {text_of(block.get('content'))}", width)


def digest(path: Path, width: int) -> Iterator[str]:
    """Yield the timeline of one session file.

    Args:
        path: Path to a JSONL transcript.
        width: Maximum characters per line.

    Yields:
        A header line, then timeline lines.
    """
    yield f"=== {path}"
    with path.open(encoding="utf-8") as handle:
        for raw in handle:
            try:
                entry: Any = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                yield from entry_lines(entry, width)


def main() -> None:
    """Parse arguments and print the digest of each session file."""
    parser: argparse.ArgumentParser = argparse.ArgumentParser(
        description="Condense session transcripts into a timeline."
    )
    parser.add_argument(
        "sessions", nargs="*", type=Path, help="JSONL files (default: find them)"
    )
    parser.add_argument(
        "--recent", type=int, default=5, help="number of recent sessions to find"
    )
    parser.add_argument(
        "--cwd", type=Path, default=Path.cwd(), help="project whose sessions to find"
    )
    parser.add_argument(
        "--all-projects", action="store_true", help="find sessions of every project"
    )
    parser.add_argument(
        "--list", action="store_true", help="print the session paths only"
    )
    parser.add_argument(
        "--width", type=int, default=240, help="maximum characters per line"
    )
    args: argparse.Namespace = parser.parse_args()
    paths: list[Path] = (
        args.sessions or find_sessions(args.cwd, args.all_projects)[: args.recent]
    )
    if args.list:
        print("\n".join(str(path) for path in paths))
        return
    for path in paths:
        for line in digest(path, args.width):
            print(line)


if __name__ == "__main__":
    main()
