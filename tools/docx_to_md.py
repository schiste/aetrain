#!/usr/bin/env python3
"""Convert .docx files to clean Markdown.

Stdlib-only: no external dependencies. Reads OOXML directly from the .docx zip.

Usage:
    python3 tools/docx_to_md.py INPUT.docx [OUTPUT.md]

Handles:
  - Heading1..Heading6 -> # .. ######
  - Bullet and numbered lists (with nesting via w:ilvl)
  - Bold / italic runs
  - Hyperlinks (resolved through word/_rels/document.xml.rels)
  - Smart-quote / dash normalization
"""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"w": W_NS, "r": R_NS}
W = f"{{{W_NS}}}"
R = f"{{{R_NS}}}"


# --- numbering.xml parsing ---------------------------------------------------

def load_numbering(z: zipfile.ZipFile) -> dict[str, dict[str, str]]:
    """Return {numId: {ilvl: numFmt}} so we know bullet vs decimal per level."""
    try:
        data = z.read("word/numbering.xml")
    except KeyError:
        return {}
    root = ET.fromstring(data)
    abstract: dict[str, dict[str, str]] = {}
    for an in root.findall("w:abstractNum", NS):
        aid = an.get(f"{W}abstractNumId")
        fmt: dict[str, str] = {}
        for lvl in an.findall("w:lvl", NS):
            ilvl = lvl.get(f"{W}ilvl")
            nf = lvl.find("w:numFmt", NS)
            fmt[ilvl] = nf.get(f"{W}val") if nf is not None else "bullet"
        abstract[aid] = fmt
    num_to_fmt: dict[str, dict[str, str]] = {}
    for n in root.findall("w:num", NS):
        nid = n.get(f"{W}numId")
        abs_ref = n.find("w:abstractNumId", NS)
        if abs_ref is not None:
            num_to_fmt[nid] = abstract.get(abs_ref.get(f"{W}val"), {})
    return num_to_fmt


# --- relationships (hyperlinks) ---------------------------------------------

def load_relationships(z: zipfile.ZipFile) -> dict[str, str]:
    try:
        data = z.read("word/_rels/document.xml.rels")
    except KeyError:
        return {}
    root = ET.fromstring(data)
    rels: dict[str, str] = {}
    for rel in root:
        rid = rel.get("Id")
        target = rel.get("Target")
        if rid and target:
            rels[rid] = target
    return rels


# --- run / paragraph rendering ----------------------------------------------

def render_run(r: ET.Element) -> str:
    """A run is a span of consistent formatting. Return inline-Markdown text."""
    text_parts: list[str] = []
    for child in r:
        tag = child.tag
        if tag == f"{W}t":
            text_parts.append(child.text or "")
        elif tag == f"{W}tab":
            text_parts.append("\t")
        elif tag == f"{W}br":
            text_parts.append("  \n")
    text = "".join(text_parts)
    if not text:
        return ""

    rPr = r.find("w:rPr", NS)
    bold = rPr is not None and rPr.find("w:b", NS) is not None
    italic = rPr is not None and rPr.find("w:i", NS) is not None

    # Apply emphasis without swallowing surrounding whitespace
    leading = len(text) - len(text.lstrip())
    trailing = len(text) - len(text.rstrip())
    core = text[leading : len(text) - trailing] if trailing else text[leading:]
    if not core:
        return text
    if bold:
        core = f"**{core}**"
    if italic:
        core = f"*{core}*"
    return text[:leading] + core + (text[-trailing:] if trailing else "")


def render_paragraph_inline(p: ET.Element, rels: dict[str, str]) -> str:
    """Render a paragraph's content (not its block-level prefix like # or -)."""
    out: list[str] = []
    for child in p:
        if child.tag == f"{W}r":
            out.append(render_run(child))
        elif child.tag == f"{W}hyperlink":
            inner = "".join(render_run(r) for r in child.findall("w:r", NS))
            rid = child.get(f"{R}id")
            href = rels.get(rid, "") if rid else ""
            anchor = child.get(f"{W}anchor")
            if not href and anchor:
                href = f"#{anchor}"
            out.append(f"[{inner}]({href})" if href else inner)
    return "".join(out)


# --- block-level dispatch ---------------------------------------------------

HEADING_RE = re.compile(r"^Heading([1-6])$")


def paragraph_style(p: ET.Element) -> str:
    pStyle = p.find("w:pPr/w:pStyle", NS)
    return pStyle.get(f"{W}val") if pStyle is not None else ""


def list_info(p: ET.Element) -> tuple[str | None, int]:
    """Return (numId, ilvl) for a list paragraph, or (None, 0)."""
    numPr = p.find("w:pPr/w:numPr", NS)
    if numPr is None:
        return None, 0
    numId_el = numPr.find("w:numId", NS)
    ilvl_el = numPr.find("w:ilvl", NS)
    numId = numId_el.get(f"{W}val") if numId_el is not None else None
    ilvl = int(ilvl_el.get(f"{W}val")) if ilvl_el is not None else 0
    return numId, ilvl


def normalize_text(s: str) -> str:
    """Replace Word-isms with plain ASCII where it improves Markdown output."""
    return (
        s.replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("–", "-")
        .replace("—", "--")
        .replace(" ", " ")
    )


# --- title block: USER CONTRIBUTION ----------------------------------------

def format_title_block(title_paragraphs: list[str]) -> list[str]:
    """Render the leading untitled paragraphs as a single H1.

    Convention chosen for this repo: drop the subtitle/date Word puts at the
    top of every doc. The project name becomes a clean H1, and every Word
    Heading-N is demoted by one level so the outline stays monotonic.

    Word's all-caps title styling (e.g. "AETRAIN") is normalized to title-case
    because Markdown carries emphasis through its own primitives.
    """
    if not title_paragraphs:
        return []
    # Strip Markdown emphasis markers the run-renderer added (Word commonly
    # bolds the title for visual weight; that becomes ** in our pipeline).
    name = re.sub(r"^[*_]+|[*_]+$", "", title_paragraphs[0]).strip()
    if name.isupper():
        name = name.capitalize()
    return [f"# {name}"]


# Heading-level shift applied to all Word Heading-N styles. Lifted to a module
# constant so the title-block convention and the body heading levels stay in
# sync — change one, change the other.
HEADING_SHIFT = 1


# --- main conversion --------------------------------------------------------

def convert(docx_path: Path) -> str:
    with zipfile.ZipFile(docx_path) as z:
        doc_xml = z.read("word/document.xml")
        rels = load_relationships(z)
        numbering = load_numbering(z)

    body = ET.fromstring(doc_xml).find("w:body", NS)
    paragraphs = body.findall("w:p", NS)

    out_lines: list[str] = []
    title_buffer: list[str] = []
    in_title = True
    list_counters: dict[tuple[str, int], int] = {}

    def flush_blank() -> None:
        if out_lines and out_lines[-1] != "":
            out_lines.append("")

    for p in paragraphs:
        style = paragraph_style(p)
        numId, ilvl = list_info(p)
        text = normalize_text(render_paragraph_inline(p, rels)).strip()

        # Skip wholly-empty paragraphs except as separators (handled via flush_blank)
        is_empty = text == ""

        # --- title block (the first run of plain paragraphs) ---
        if in_title:
            if is_empty:
                if title_buffer:
                    out_lines.extend(format_title_block(title_buffer))
                    out_lines.append("")
                    in_title = False
                continue
            if style or numId is not None:
                # We hit real content before any blank line; close the title block.
                if title_buffer:
                    out_lines.extend(format_title_block(title_buffer))
                    out_lines.append("")
                in_title = False
                # fall through to handle this paragraph
            else:
                title_buffer.append(text)
                continue

        if is_empty:
            list_counters.clear()
            flush_blank()
            continue

        # --- heading ---
        m = HEADING_RE.match(style or "")
        if m:
            level = min(int(m.group(1)) + HEADING_SHIFT, 6)
            flush_blank()
            out_lines.append(f"{'#' * level} {text}")
            out_lines.append("")
            list_counters.clear()
            continue

        # --- list item ---
        if numId is not None:
            fmt = numbering.get(numId, {}).get(str(ilvl), "bullet")
            indent = "  " * ilvl
            if fmt == "decimal":
                key = (numId, ilvl)
                list_counters[key] = list_counters.get(key, 0) + 1
                marker = f"{list_counters[key]}."
            else:
                marker = "-"
            out_lines.append(f"{indent}{marker} {text}")
            continue

        # --- regular paragraph ---
        out_lines.append(text)
        out_lines.append("")

    # Edge case: doc never had a blank line after its title
    if in_title and title_buffer:
        out_lines = format_title_block(title_buffer) + [""] + out_lines

    # Collapse runs of >1 blank line
    cleaned: list[str] = []
    for line in out_lines:
        if line == "" and cleaned and cleaned[-1] == "":
            continue
        cleaned.append(line)
    while cleaned and cleaned[-1] == "":
        cleaned.pop()
    return "\n".join(cleaned) + "\n"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(argv[1])
    dst = Path(argv[2]) if len(argv) > 2 else src.with_suffix(".md")
    md = convert(src)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(md, encoding="utf-8")
    print(f"{src} -> {dst}  ({len(md)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
