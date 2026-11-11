"""Find tagged requirements in a PDF and give each one a region on its page.

  python -I -X utf8 pdf_tags.py <file.pdf> [--tag-re 'R-[A-Z0-9]{3}'] [--pdftotext PATH]

Needs poppler's pdftotext (it has -bbox-layout). For each word that matches the tag pattern it
prints the whole text line that holds it, the page number and the line's box as 0-1 fractions of
the page: {"tag", "page", "region": {page, x, y, w, h}, "text"}. Also prints every other line, so
untagged context is visible. Reads the file only.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--tag-re", default=r"R-[A-Z0-9]{3}")
    ap.add_argument("--pdftotext", default=shutil.which("pdftotext") or "pdftotext")
    a = ap.parse_args()
    r = subprocess.run([a.pdftotext, "-bbox-layout", a.pdf, "-"], capture_output=True)
    if r.returncode or b"<page" not in r.stdout:
        sys.exit("ERROR: pdftotext -bbox-layout failed | HINT: use poppler's pdftotext (xpdf's has no -bbox)")
    xml = re.sub(rb"<!DOCTYPE[^>]*>", b"", r.stdout)
    xml = re.sub(rb'xmlns="[^"]+"', b"", xml)
    root = ET.fromstring(xml)
    tag_re = re.compile(a.tag_re)
    out = {"file": a.pdf, "tags": [], "lines": []}
    for pno, page in enumerate(root.iter("page"), start=1):
        pw, ph = float(page.get("width")), float(page.get("height"))
        for line in page.iter("line"):
            words = [w.text or "" for w in line.iter("word")]
            text = " ".join(words)
            x0, y0 = float(line.get("xMin")), float(line.get("yMin"))
            x1, y1 = float(line.get("xMax")), float(line.get("yMax"))
            region = {"page": pno, "x": round(x0 / pw, 4), "y": round(y0 / ph, 4),
                      "w": round((x1 - x0) / pw, 4), "h": round((y1 - y0) / ph, 4)}
            out["lines"].append({"page": pno, "text": text, "region": region})
            for w in words:
                m = tag_re.fullmatch(w.strip(" .,:;—-")) or tag_re.search(w)
                if m:
                    out["tags"].append({"tag": m.group(0), "page": pno, "region": region, "text": text})
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
