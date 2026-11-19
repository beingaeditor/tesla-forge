"""Render docs/WRITEUP.md to docs/WRITEUP.pdf (A4) with headless Edge or Chrome.

    python scripts/writeup_pdf.py
"""
import os
import pathlib
import re
import subprocess
import sys

from markdown_it import MarkdownIt

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "docs" / "WRITEUP.md").read_text(encoding="utf-8")
src = re.sub(r"^> Draft\..*\n\n", "", src, flags=re.M)  # drop the drafting note
body = MarkdownIt("commonmark").enable("table").render(src)

css = """
@page { size: A4; margin: 14mm 15mm; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 9.6pt; line-height: 1.38; color: #111; }
h1 { font-size: 16pt; margin: 0 0 6px; }
h2 { font-size: 11.5pt; margin: 12px 0 4px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
p, li { margin: 3px 0; }
ul, ol { margin: 3px 0; padding-left: 18px; }
table { border-collapse: collapse; width: 100%; margin: 5px 0; font-size: 8.8pt; }
th, td { border: 1px solid #bbb; padding: 3px 5px; vertical-align: top; text-align: left; }
th { background: #f0f0f0; }
code { font-family: Consolas, monospace; font-size: 8.6pt; background: #f4f4f4; padding: 0 2px; }
a { color: #0b57d0; text-decoration: none; }
"""
html = f'<!doctype html><html><head><meta charset="utf-8"><title>Tesla Forge write-up</title><style>{css}</style></head><body>{body}</body></html>'
out_html = root / "docs" / "WRITEUP.html"
out_pdf = root / "docs" / "WRITEUP.pdf"
out_html.write_text(html, encoding="utf-8")

browsers = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "google-chrome",
    "chromium",
]
exe = next((b for b in browsers if os.path.exists(b)), browsers[-2])
subprocess.run(
    [exe, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={out_pdf}", out_html.as_uri()],
    check=True, capture_output=True, timeout=120,
)
out_html.unlink()
pages = len(re.findall(rb"/Type\s*/Page[^s]", out_pdf.read_bytes()))
print(f"{out_pdf.relative_to(root)}: {pages} page(s)")
fills = src.count("[FILL")
if fills:
    print(f"warning: {fills} [FILL] placeholder(s) still in the write-up", file=sys.stderr)
