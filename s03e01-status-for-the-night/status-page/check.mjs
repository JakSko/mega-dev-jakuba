// Checker (spec R10): fetch the deployed page and status.json like a stranger and test every
// accepted tag it can, plus product's answer (R-L3K). Prints PASS/FAIL per check; exit 1 on any FAIL.
//   node check.mjs <base url> <feed url>
// Sends only GET and OPTIONS requests. No cookies.
const base = (process.argv[2] || '').replace(/\/$/, '');
const feedUrl = process.argv[3];
if (!base || !feedUrl) { console.error('usage: node check.mjs <base url> <feed url>'); process.exit(2); }

const results = [];
const check = (name, ok, got = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  | got: ${String(got).slice(0, 160)}`}`); };
const text = (h) => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const dm = (iso) => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const hm = (iso) => { const d = new Date(iso); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

console.log(`check ${base} at ${new Date().toISOString()}`);
const pr = await fetch(base + '/', { headers: { 'user-agent': 'status-check/1' } });
const html = await pr.text();
const t = text(html);
check('page answers 200 over https, no login', pr.status === 200 && base.startsWith('https://') && !/login|sign in/i.test(t), `${pr.status} ${base}`);
check('R-Z5L heading "status for the night"', /<h1[^>]*>\s*status for the night\s*<\/h1>/.test(html), html.match(/<h1[^>]*>.*?<\/h1>/)?.[0]);
check('R-M9Z banner text exactly "Some services had problems overnight."', /class="banner"[^>]*>Some services had problems overnight\.</.test(html));
check('R-M9Z banner amber #F5A623', /\.banner\{[^}]*background:#F5A623/i.test(html));
check('R-X2M "read by tram 3 boards" visible', t.includes('read by tram 3 boards'));
check('R-H4L footer "all times UTC"', /<footer[^>]*>[^<]*all times UTC/.test(html));
check('no script, no cookie (no tracking)', !/<script/i.test(html) && !pr.headers.get('set-cookie'));

const jr = await fetch(base + '/status.json', { headers: { origin: 'https://tram3-board.example' } });
const js = await jr.json();
const feed = await (await fetch(feedUrl, { cache: 'no-store' })).json();
check('R-K4M status.json Access-Control-Allow-Origin: *', jr.headers.get('access-control-allow-origin') === '*', jr.headers.get('access-control-allow-origin'));
const age = /max-age=(\d+)/.exec(jr.headers.get('cache-control') || '');
check('R-L5Z status.json Cache-Control max-age <= 60', !!age && Number(age[1]) <= 60, jr.headers.get('cache-control'));
check('status.json is application/json', /^application\/json/.test(jr.headers.get('content-type') || ''));
check('R-H8X updatedAt in UTC ending in Z', /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z$/.test(js.updatedAt), js.updatedAt);
const skew = Math.abs(new Date(feed.updatedAt) - new Date(js.updatedAt)) / 1000;
check(`R-K8L updatedAt = the ops feed's (within 60 s; feed ${feed.updatedAt}, ours ${js.updatedAt})`, skew <= 60, `${skew}s`);
const fid = feed.incidents.map((i) => String(i.id)).sort();
const jid = js.incidents.map((i) => String(i.id)).sort();
check('status.json rows = the live feed rows', JSON.stringify(fid) === JSON.stringify(jid), jid.join(','));
const opened = js.incidents.map((i) => i.opened);
check('R-M3H newest first (status.json, by opened)', opened.every((o, k) => k === 0 || opened[k - 1] >= o), opened.join(' '));
const pageIds = [...html.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
check('page and status.json say the same thing (same rows, same order)', JSON.stringify(pageIds) === JSON.stringify(js.incidents.map((i) => String(i.id))), pageIds.join(','));
const rowOk = js.incidents.every((i) => new RegExp(`data-id="${i.id}"><td>${dm(i.opened)}</td><td>${hm(i.opened)}</td><td>${i.closed ? hm(i.closed) : ''}</td>`).test(html));
check('R-L3K dates day first (dd/mm), times 24 h HH:MM UTC', rowOk);
check('R-X5K each incident shows who ran it (feed author as given)', js.incidents.every((i) => html.includes(`<td>${i.author}</td></tr>`)));
const lineTable = (html.split('<table id="lines">')[1] || '').split('</table>')[0];
const linesWanted = [...new Set(['tram 3', ...feed.incidents.map((i) => i.line)])];
check('R-Z2K every line has its own row, tram 3 included', linesWanted.every((l) => lineTable.includes(`<td>${l}</td>`)), linesWanted.join(','));

const op = await fetch(base + '/status.json', { method: 'OPTIONS', headers: { origin: 'https://tram3-board.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-probe' } });
check('preflight OPTIONS allowed for any origin', op.status >= 200 && op.status < 300 && op.headers.get('access-control-allow-origin') === '*', `${op.status} ${op.headers.get('access-control-allow-origin')}`);

const fails = results.filter((r) => !r).length;
console.log(`${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
