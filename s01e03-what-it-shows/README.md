# S01E03 - what it shows

Solved 2026-11-03. The public result is its own repo: [JakSko/mega-s01e03-what-it-shows](https://github.com/JakSko/mega-s01e03-what-it-shows) (issues, the kb page, the render setup).

**The task, in my words:** a support desk merged 412 reports into one ticket and marked it known. Find the problems the ticket really holds, file one GitHub issue per problem with how many reports it covers, and add a page about them to the desk's knowledge base. The desk keeps working meanwhile.

**What decided it:** counting the way the desk counts (its own rule for reports read two ways), rendering the page instead of trusting its source, and re-reading the live page before each claim. Two refused claims taught those three.

These scripts produced the numbers and the issue bodies:

| File | What it does |
|---|---|
| `scripts/group.mjs` | runs the desk's own grouping code on the export |
| `scripts/check.py` | an independent count from the report bodies; must agree with `group.mjs` |
| `scripts/problems.py` | one problem per cause, counted the desk's way |
| `scripts/bodies.py` | issue bodies built from the numbers, so a rule change is one edit and a rebuild |
| `scripts/walk_kb.py`, `scripts/html_text.py` | walk the kb as an agent would, read rendered text |
| `scripts/scan_bodies.py` | flags report text aimed at an agent before anything reads it |

They expect the kb export, which is course material and is in the public repo only as the desk handed it out.
