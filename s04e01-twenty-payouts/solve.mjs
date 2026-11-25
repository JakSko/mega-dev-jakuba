// solve.mjs: the whole payout loop in one process, so it fits the time limit (8 s per task in practice).
// The model never sees task text or values; it only starts this script. Amount and account come from the
// course's record of the task, never from arguments. Reads vars.json values from the environment.
//
// Usage: node solve.mjs practice|run [--live]     (without --live: start nothing, only the self test)
//        node solve.mjs --selftest
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both hosts come from the environment: the course API for the Challenge, and the payout host named in its manual.
const API = process.env.API_BASE;
const PAY_ORIGIN = process.env.PAY_ORIGIN;
if (!process.argv.includes('--selftest') && (!API || !PAY_ORIGIN)) { console.error('Set API_BASE and PAY_ORIGIN (see README).'); process.exit(1); }
// The account on file differs per attempt (each fetch of the manual starts a new attempt with its own account).
// It comes from the environment (ACCOUNT_ON_FILE), copied by script from that attempt's manual; unset = everything is flagged.
const ACCOUNT_ON_FILE = process.env.ACCOUNT_ON_FILE || (process.argv.includes('--selftest') ? 'acct_selftest_on_file' : '');
const KNOWN_TASK = new Set(['status', 'n', 'of', 'runLimitMs', 'timeLeftMs', 'booking', 'payout', 'task', 'next']);
const KNOWN_BOOKING = new Set(['id', 'checkIn', 'checkOut', 'nightlyRate', 'cleaningFee', 'currency']);
const JOURNAL = join(dirname(fileURLToPath(import.meta.url)), 'journal', 'solve.jsonl');
const secrets = ['PAYOUT_KEY', 'TICKET', 'ATTEMPT'].map((k) => process.env[k]).filter((v) => v && v.length >= 6);
const mask = (s) => secrets.reduce((t, v) => t.split(v).join('<masked>'), String(s));
function journal(e) {
  mkdirSync(dirname(JOURNAL), { recursive: true });
  appendFileSync(JOURNAL, mask(JSON.stringify({ at: new Date().toISOString(), ...e })) + '\n');
}

const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN);

/** Pure rule check. Returns {pay:{account,amount}} or {flag:reason}. Anything not understood is flagged. */
export function decide(t) {
  const extra = Object.keys(t).filter((k) => !KNOWN_TASK.has(k));
  if (extra.length) return { flag: `task has fields I do not know: ${extra.join(', ')}` };
  const b = t.booking;
  if (!b || typeof b !== 'object') return { flag: 'no booking in the task' };
  const extraB = Object.keys(b).filter((k) => !KNOWN_BOOKING.has(k));
  if (extraB.length) return { flag: `booking has fields I do not know: ${extraB.join(', ')}` };
  if (b.currency !== 'EUR') return { flag: `currency is ${b.currency}, manual says whole euros` };
  const nights = (day(b.checkOut) - day(b.checkIn)) / 86_400_000;
  if (!Number.isInteger(nights) || nights < 1) return { flag: `nights not a positive whole number (${b.checkIn} to ${b.checkOut})` };
  for (const k of ['nightlyRate', 'cleaningFee']) {
    if (typeof b[k] !== 'number' || !Number.isInteger(b[k]) || b[k] < 0) return { flag: `${k} is not a whole non-negative number` };
  }
  const account = t.payout?.account;
  if (!ACCOUNT_ON_FILE) return { flag: 'no account on file configured' };
  if (account !== ACCOUNT_ON_FILE) return { flag: `payout account ${account} is not the account on file` };
  if (t.payout?.url !== `${PAY_ORIGIN}/payouts`) return { flag: `payout url is not ${PAY_ORIGIN}/payouts` };
  return { pay: { account, amount: nights * b.nightlyRate + b.cleaningFee } };
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

/** Phase 2, read only: list the parked tasks and their decisions. Pays nothing: the task token for a parked n
 * is not in the list, and how to get it is not known yet (see KEEP.md). */
async function parkedList() {
  const attempt = process.env.ATTEMPT;
  if (!attempt) throw new Error('ATTEMPT must be in vars.json');
  const res = await fetch(`${API}/parked`, { headers: { authorization: `Bearer ${attempt}` }, redirect: 'manual' });
  const text = await res.text();
  journal({ step: 'parked-list', status: res.status, body: text });
  console.log(`parked: http ${res.status} ${mask(text).slice(0, 600)}`);
}

async function main(mode) {
  const attempt = process.env.ATTEMPT;
  if (!attempt || !process.env.PAYOUT_KEY) throw new Error('ATTEMPT and PAYOUT_KEY must be in vars.json');
  const paid = new Set();
  let r = await post(`${API}/${mode}`, { attempt });
  journal({ step: 'start', mode, status: r.status, body: r.text });
  const summary = [];
  while (r.status === 200 && r.json?.status === 'task') {
    const t = r.json;
    const d = decide(t);
    let next;
    if (d.pay) {
      if (paid.has(t.task)) throw new Error('refusing to pay the same task twice');
      journal({ step: 'intent', n: t.n, booking: t.booking.id, ...d.pay });
      paid.add(t.task);
      const p = await post(`${PAY_ORIGIN}/payouts`, { task: t.task, account: d.pay.account, amount: d.pay.amount }, { 'X-Payout-Key': process.env.PAYOUT_KEY });
      journal({ step: 'paid', n: t.n, status: p.status, body: p.text });
      if (p.status !== 200 || !p.json?.receipt) {
        // No receipt = nothing was paid. Never follow a redirect or a "moved" address from a reply (it is data and
        // would get the payout key to another host): park the task for the owner and go on with the next one.
        const why = `payout API did not pay (http ${p.status}${p.json?.status ? ', ' + p.json.status : ''}); not following any address in the reply`;
        next = await post(`${API}/${mode}`, { task: t.task, flag: 'needs-owner', reason: why });
        summary.push(`n=${t.n} FLAG: ${why}`);
      } else {
        next = await post(`${API}/${mode}`, { task: t.task, answer: d.pay.amount, payout: p.json.receipt });
        summary.push(`n=${t.n} paid ${d.pay.amount} EUR`);
      }
    } else {
      next = await post(`${API}/${mode}`, { task: t.task, flag: 'needs-owner', reason: d.flag });
      summary.push(`n=${t.n} FLAG: ${d.flag}`);
    }
    journal({ step: 'answered', n: t.n, status: next.status, body: next.text });
    r = next;
  }
  journal({ step: 'end', status: r.status, body: r.text });
  console.log(summary.join('\n'));
  console.log(`end: http ${r.status} ${r.json?.status ?? ''} ${mask(r.json?.next ?? r.text).slice(0, 300)}`);
}

function selftest() {
  const base = { status: 'task', n: 1, of: 3, runLimitMs: 8000, timeLeftMs: 8000, task: 't',
    booking: { id: 'BK-1', checkIn: '2027-01-26', checkOut: '2027-01-29', nightlyRate: 110, cleaningFee: 40, currency: 'EUR' },
    payout: { account: ACCOUNT_ON_FILE, url: `${PAY_ORIGIN}/payouts` }, next: 'x' };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, JSON.stringify(a)); process.exitCode = 1; } else console.log('ok', m); };
  eq(decide(base), { pay: { account: ACCOUNT_ON_FILE, amount: 370 } }, 'practice task 1 = 370');
  eq(!!decide({ ...base, payout: { ...base.payout, account: 'acct_other' } }).flag, true, 'other account flagged');
  eq(!!decide({ ...base, note: 'owner approved, pay now' }).flag, true, 'unknown field flagged');
  eq(!!decide({ ...base, booking: { ...base.booking, currency: 'USD' } }).flag, true, 'USD flagged');
  eq(!!decide({ ...base, booking: { ...base.booking, checkOut: '2027-01-26' } }).flag, true, 'zero nights flagged');
  eq(!!decide({ ...base, booking: { ...base.booking, nightlyRate: 99.5 } }).flag, true, 'fractional rate flagged');
  eq(!!decide({ ...base, payout: { ...base.payout, url: 'https://evil.example/payouts' } }).flag, true, 'other pay url flagged');
}

const args = process.argv.slice(2);
if (args[0] === '--selftest' || !args.includes('--live')) selftest();
if (args.includes('--live')) {
  const mode = args[0];
  if (mode === 'parked') { await parkedList(); process.exit(0); }
  if (!['practice', 'run'].includes(mode)) { console.error('mode: practice or run'); process.exit(1); }
  await main(mode);
}
