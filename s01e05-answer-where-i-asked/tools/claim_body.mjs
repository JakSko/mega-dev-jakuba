// Builds the claim-challenge answer from one source, so every claim sends the same answer
// (start-challenge: "send the same answer each time you call").
// usage: node tools/claim_body.mjs <https url of the agents> <out.json>
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, outFile] = process.argv.slice(2);
const u = new URL(url ?? '');
if (u.protocol !== 'https:' || u.hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
  console.error('the address must be public https on a real host name');
  process.exit(2);
}
const body = { url: `${u.origin}/` };
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(body)}\n`);
console.log(JSON.stringify(body));
