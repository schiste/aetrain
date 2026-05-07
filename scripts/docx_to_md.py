#!/usr/bin/env python3
"""Compatibility shim for the relocated docx-to-markdown tool."""

from __future__ import annotations

import runpy
from pathlib import Path


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[1] / "tools" / "docx_to_md.py"
    runpy.run_path(str(target), run_name="__main__")
