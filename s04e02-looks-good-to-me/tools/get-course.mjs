// One GET to the course. The whole reply goes to <outdir>/<name>.raw (a git-ignored folder), a masked copy to
// <outdir>/<name>.masked.txt, and only the masked copy is printed. If a reply to the TICKET holds `attempt`, it is
// stored in vars.json as ATTEMPT before anything is masked or printed. No redirect is followed.
//
// Usage: node tools/get-course.mjs <url> <TICKET|ATTEMPT> <name> <outdir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact } from '../lib/redact.mjs';

const DESK = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function getCourse({ url, auth, name, outdir, varsFile = join(DESK, 'vars.json'), origin = process.env.COURSE_ORIGIN ?? 'https://course.example', fetchImpl = fetch }) {
  if (new URL(url).origin !== origin) throw new Error(`refused: ${new URL(url).origin} is not ${origin}`);
  if (!['TICKET', 'ATTEMPT'].includes(auth)) throw new Error('auth must be TICKET or ATTEMPT');
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error('name may hold letters, digits and - only');
  const vars = JSON.parse(readFileSync(varsFile, 'utf8'));
  if (!vars[auth] || /^<.*>$/.test(vars[auth])) throw new Error(`${auth} is not in vars.json`);
  mkdirSync(outdir, { recursive: true });
  if (existsSync(join(outdir, `${name}.raw`))) throw new Error(`${name}.raw exists: pick another name, so that no saved reply is overwritten`);
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${vars[auth]}` }, redirect: 'manual' });
  const text = await res.text();
  writeFileSync(join(outdir, `${name}.raw`), text);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  let stored = false;
  if (auth === 'TICKET' && res.status === 200 && typeof json?.attempt === 'string') {
    vars.ATTEMPT = json.attempt;
    writeFileSync(varsFile, JSON.stringify(vars, null, 2) + '\n');
    stored = true;
  }
  const secrets = Object.entries(vars).filter(([, v]) => typeof v === 'string' && v.length >= 6);
  let masked = redact(text, secrets);
  // A reply to the TICKET with no `attempt` field may hold one in its text: mask every long unbroken string.
  if (auth === 'TICKET' && !stored) masked = masked.replace(/[A-Za-z0-9_.~+=-]{32,}/g, '<masked-long>');
  writeFileSync(join(outdir, `${name}.masked.txt`), masked);
  return { status: res.status, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), location: res.headers.get('location') ? redact(res.headers.get('location'), secrets) : null, stored, masked };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url, auth, name, outdir] = process.argv.slice(2);
  if (!outdir) { console.error('Usage: node tools/get-course.mjs <url> <TICKET|ATTEMPT> <name> <outdir>'); process.exit(1); }
  const r = await getCourse({ url, auth, name, outdir });
  console.log(`http ${r.status}, ${r.bytes} bytes, sha256 ${r.sha256}${r.location ? `, location ${r.location} (not followed)` : ''}${r.stored ? ', ATTEMPT stored in vars.json' : ''}`);
  console.log(r.masked);
}
