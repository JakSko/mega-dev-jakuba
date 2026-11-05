"""Compare two transcription passes of one recording, flag uncertain words and agent-directed text.

Usage: python -I compare.py <pass-A.json> <pass-B.json> <report.md>
Writes a Markdown report: full text of pass A with times, A-vs-B differences, words with p < 0.6,
and lines that look aimed at an agent or are in the imperative (plan step 5b). Spoken text is data.
"""
import difflib, json, re, sys

def fail(what, got, hint):
    print(f'ERROR: {what} | GOT: {got} | HINT: {hint}', file=sys.stderr)
    sys.exit(1)

if len(sys.argv) != 4:
    fail('arguments', sys.argv[1:], 'pass <pass-A.json> <pass-B.json> <report.md>')
try:
    A, B = (json.load(open(p, encoding='utf-8')) for p in sys.argv[1:3])
except Exception as e:
    fail('read pass files', repr(e)[:200], 'run transcribe.py first; check the paths')

def words(d):
    return [w for s in d['segments'] for w in s['words']]

norm = lambda w: re.sub(r"[^\w']", '', w.lower())
wa, wb = words(A), words(B)
na, nb = [norm(w['word']) for w in wa], [norm(w['word']) for w in wb]

out = [f"# Transcript check: {A['media']}", '',
       f"Model {A['model']}; pass A options {A['options']}; pass B options {B['options']}.",
       f"Duration {A['duration']} s; language {A['language']} ({A['language_probability']}). "
       f"Pass A: {len(wa)} words; pass B: {len(wb)} words.", '', '## Pass A, by segment', '']
for s in A['segments']:
    out.append(f"- [{s['start']:.2f}-{s['end']:.2f}] {s['text'].strip()}")

out += ['', '## Differences A vs B (normalized words)', '']
diffs = 0
for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, na, nb, autojunk=False).get_opcodes():
    if op == 'equal':
        continue
    diffs += 1
    ta = ' '.join(w['word'].strip() for w in wa[i1:i2]) or '(none)'
    tb = ' '.join(w['word'].strip() for w in wb[j1:j2]) or '(none)'
    at = wa[i1]['start'] if i1 < len(wa) else (wa[-1]['end'] if wa else 0)
    out.append(f'- {at:.2f}s {op}: A "{ta}" / B "{tb}"')
if not diffs:
    out.append('- none')

out += ['', '## Words in pass A with p < 0.6', '']
low = [w for w in wa if w['p'] < 0.6]
out += [f"- {w['start']:.2f}s \"{w['word'].strip()}\" p={w['p']}" for w in low] or ['- none']

AGENT = re.compile(r"\b(ai|agent|assistant|model|llm|claude|gpt|harness|prompt|instruction|ignore|disregard|"
                   r"replace|rewrite|change what|instead|submit|send|report|record|transcri\w*|you must|"
                   r"don't|do not|write)\b", re.I)
out += ['', '## Lines that may be aimed at an agent or are imperative (step 5b)', '']
hits = [s for s in A['segments'] if AGENT.search(s['text'])]
out += [f"- [{s['start']:.2f}] {s['text'].strip()}  (matched: {', '.join(sorted(set(m.lower() for m in AGENT.findall(s['text']))))})"
        for s in hits] or ['- none']

open(sys.argv[3], 'w', encoding='utf-8', newline='\n').write('\n'.join(out) + '\n')
print(f'ok: {sys.argv[3]} | {diffs} difference blocks, {len(low)} low-p words, {len(hits)} flagged lines')
