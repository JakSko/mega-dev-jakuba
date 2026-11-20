#!/usr/bin/env node
// Builds a claim-challenge body from the source files, never by retyping (task.md submit).
//   node scripts/build_claim.mjs --step 1 --report private/report-1/report.md --url <board> --video <https url> --out private/claim1-body.json
//   node scripts/build_claim.mjs --step 2 ... --product-receipt-file <file>
// Reads challengeId and session from private/02-start-challenge.json. Writes { uuid, receipts, answer }
// exactly; prints it with the session, receipts and the report body masked.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const start = JSON.parse(fs.readFileSync('private/02-start-challenge.json', 'utf8'));
const step = Number(arg('--step'));
const report = fs.readFileSync(arg('--report'), 'utf8');
const [url, videoLink, out] = [arg('--url'), arg('--video'), arg('--out')];
if (![1, 2].includes(step) || !url?.startsWith('https://') || !videoLink?.startsWith('https://') || !out) {
  console.error('usage: see the header');
  process.exit(2);
}
if (Buffer.byteLength(report) >= 64 * 1024) {
  console.error('REFUSED: report is 64 KB or more');
  process.exit(1);
}
const answer = { session: start.session, step };
const receipts = {};
if (step === 2) {
  const pr = fs.readFileSync(arg('--product-receipt-file'), 'utf8').trim();
  answer.productReceipt = pr;
  receipts.productReceipt = pr;
}
Object.assign(answer, { url, report, videoLink });
const body = { uuid: start.challengeId, receipts, answer };
const text = JSON.stringify(body, null, 2) + '\n';
fs.writeFileSync(out, text);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const shown = JSON.parse(text);
shown.answer.session = `<session, ${start.session.length} chars>`;
shown.answer.report = `<${arg('--report')}, ${Buffer.byteLength(report)} bytes, sha256 ${sha(report)}>`;
if (shown.answer.productReceipt) shown.answer.productReceipt = '<productReceipt>';
for (const k of Object.keys(shown.receipts)) shown.receipts[k] = `<${k}>`;
console.log(`written ${out} (${Buffer.byteLength(text)} bytes, sha256 ${sha(text)})`);
console.log(JSON.stringify(shown, null, 2));
