// Step 7: group the #4471 reports with the desk's own logic (src/lib/kb/causes.ts, run as is by Node 24
// type stripping). locales.ts uses import.meta.glob (Vite only), so tenantOf is rebuilt here from the
// same tenants/*.json files. Usage: node tools/group.mjs <support-kb dir> <out/groups.json>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [kb, out] = process.argv.slice(2);
const { groupByCause, uniqueById, ticketCause, readAs } = await import(pathToFileURL(join(kb, 'src/lib/kb/causes.ts')).href);
const data = join(kb, 'src/lib/data');
const tenants = new Map(
  readdirSync(join(data, 'tenants')).map((f) => {
    const t = JSON.parse(readFileSync(join(data, 'tenants', f), 'utf8'));
    return [t.handle, t];
  }),
);
const reports = JSON.parse(readFileSync(join(data, 'reports-4471.json'), 'utf8'));
const notes = JSON.parse(readFileSync(join(data, 'desk-notes.json'), 'utf8'));
const merged = uniqueById(reports).filter((r) => r.mergedInto === 4471);
const groups = groupByCause(merged, (r) => tenants.get(r.tenant));
const owner = ticketCause(groups, 4471);
const result = {
  entries: reports.length,
  unique: merged.length,
  owner,
  groups: groups.map((g) => ({
    cause: g.cause,
    count: g.reports.length,
    taggedAs: g.taggedAs,
    tenants: [...new Set(g.reports.map((r) => r.tenant))].sort(),
    channels: g.reports.reduce((n, r) => ({ ...n, [r.channel]: (n[r.channel] ?? 0) + 1 }), {}),
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    oneDayMove: readAs(g, notes.oneDayMove),
    ids: g.reports.map((r) => r.id).sort(),
  })),
};
writeFileSync(out, JSON.stringify(result, null, 2));
for (const g of result.groups) console.log(g.cause, g.count, JSON.stringify(g.channels), g.tenants.length, 'tenants', g.firstSeen, '->', g.lastSeen, 'oneDayMove', g.oneDayMove);
console.log('entries', result.entries, 'unique', result.unique, 'owner', owner, 'sum', result.groups.reduce((s, g) => s + g.count, 0));
