"""Print the visible text of a prerendered kb page (tables as rows). Usage: python -I -X utf8 tools/html_text.py <file.html>"""
import sys, html.parser

class T(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(); self.out=[]; self.skip=0; self.row=None
    def handle_starttag(self, tag, a):
        if tag in ("script","style","head"): self.skip+=1
        if tag=="tr": self.row=[]
        if tag in ("p","h1","h2","li","aside","figcaption","footer","table") and self.row is None: self.out.append("\n")
    def handle_endtag(self, tag):
        if tag in ("script","style","head"): self.skip-=1
        if tag=="tr": self.out.append("\n| "+" | ".join(c.strip() for c in self.row)+" |"); self.row=None
        if tag in ("td","th") and self.row is not None: self.row.append(""); 
    def handle_data(self, d):
        if self.skip: return
        if self.row is not None:
            if not self.row: self.row.append("")
            self.row[-1]+=d
        else: self.out.append(d)
t=T(); t.feed(open(sys.argv[1],encoding="utf-8").read())
print("\n".join(l.rstrip() for l in "".join(t.out).splitlines() if l.strip()))
