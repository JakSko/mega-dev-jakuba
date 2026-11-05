// Run in the signed-in browser tab on https://hq.mega.dev/challenges/somebody-slow
// (the built-in browser's JavaScript tool). This is the exact logic that sent the
// accepted request on 2026-11-02 21:19 UTC.
//
// It rebuilds compactedMessage from the page's own paragraphs (no retyping),
// refuses to send if the text or the 26th paragraph differs from the approved hashes,
// sends with the session cookie, and returns SHA-256 of body and reply so the
// local log copy can be checked with log_entry.py.
//
// For the full uncut message (step 3) use KEEP = all indices and
// EXPECTED = cee4bf069e120d2cf6d28b81740d05d4cb0b22f49462ba1fc1a3e38038920184.

const KEEP = [0, 2, 4, 5, 8, 10];
const EXPECTED = 'e8f8ce4f8cc3652e529731a80c1be38f46b70d03faa3e2ceb124c68684ce22f6';
const P26 = '4623fc783fa2600b95e8e1223673dfcd53622644fa961d37a51fe5751692390c';

const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
const ps = [...document.querySelectorAll('article.rook-mail .rook-mail-body p')].map(p => p.textContent);
const msg = KEEP.map(i => ps[i]).join('\n\n');
if (await sha(msg) !== EXPECTED) throw new Error('compacted hash mismatch, not sent');
if (await sha(ps[5]) !== P26) throw new Error('26th paragraph mismatch, not sent');
const body = JSON.stringify({from: 'rook', compactedMessage: msg});
const r = await fetch('/challenges/where-the-story-begins/api', {
  method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'}, body,
});
const reply = await r.text();
({sentAt: new Date().toISOString(), status: r.status, msgLen: [...msg].length,
  bodySha: await sha(body), reply, replySha: await sha(reply)})
