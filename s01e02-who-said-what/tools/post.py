"""POST one body file to a Challenge endpoint with curl; save the exact reply to private/, append a masked entry to log.md.

Usage: python -I post.py <name> <url> <body.json> "<step and who approved it>"
  name: video | audio | record (reply goes to private/reply-<name>.json, headers to private/reply-<name>.headers.txt)
Prints the HTTP status and the reply with tickets, receipts and tokens masked. Never retries on its own.
On failure: exits 1 with "ERROR: <what> | GOT: <detail> | HINT: <next thing to try>".
"""
import datetime, json, re, subprocess, sys

def fail(what, got, hint):
    print(f'ERROR: {what} | GOT: {got} | HINT: {hint}', file=sys.stderr)
    sys.exit(1)

if len(sys.argv) != 5:
    fail('arguments', sys.argv[1:], 'post.py <name> <url> <body.json> "<note>"')
name, url, body_path, note = sys.argv[1:]
SECRET_KEY = re.compile(r'ticket|receipt|token|secret|key', re.I)
SECRET_VAL = re.compile(r'v1\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)?')

def mask_str(s):
    return s[:6] + '...' + s[-4:] if len(s) > 12 else '***'

def mask(o, key=''):
    if isinstance(o, dict):
        return {k: mask(v, k) for k, v in o.items()}
    if isinstance(o, list):
        return [mask(v, key) for v in o]
    if isinstance(o, str):
        return mask_str(o) if SECRET_KEY.search(key) and len(o) > 12 else SECRET_VAL.sub(lambda m: mask_str(m.group(0)), o)
    return o

body_raw = open(body_path, encoding='utf-8').read()
try:
    body = json.loads(body_raw)
except Exception as e:
    fail('body is not JSON', repr(e)[:200], 'rebuild it with build_reports.py / build_record.py')

ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
out, hdr = f'private/reply-{name}.json', f'private/reply-{name}.headers.txt'
r = subprocess.run(['curl', '-sS', '--max-time', '60', '-o', out, '-D', hdr, '-w', '%{http_code}', '-X', 'POST',
                    '-H', 'Content-Type: application/json', '--data-binary', '@' + body_path, url],
                   capture_output=True, text=True)
status = r.stdout.strip()
if r.returncode:
    fail('curl', f'exit {r.returncode}: {r.stderr.strip()[:200]}', 'network or timeout: a course/system fault; at most one unchanged retry, then tell Jakub')
reply_raw = open(out, encoding='utf-8', errors='replace').read()
try:
    reply_shown = json.dumps(mask(json.loads(reply_raw)), indent=2, ensure_ascii=False)
except ValueError:
    reply_shown = SECRET_VAL.sub(lambda m: mask_str(m.group(0)), reply_raw[:2000])

with open('log.md', 'a', encoding='utf-8', newline='\n') as f:
    f.write(f"\n## {ts} POST {url}\n\n{note}\n\nRequest body (ticket masked; exact body in {body_path}):\n\n```json\n"
            f"{json.dumps(mask(body), ensure_ascii=False)}\n```\n\nReply (HTTP {status}; exact reply in {out}):\n\n```\n{reply_shown}\n```\n")
print(f'HTTP {status}\n{reply_shown}')
if not status.startswith('2'):
    hint = ('course fault: at most one unchanged retry, then tell Jakub' if status.startswith('5')
            else 'not accepted: quote the one line, change nothing alone, propose one change to Jakub')
    fail(f'POST {name}', f'HTTP {status}', hint)
