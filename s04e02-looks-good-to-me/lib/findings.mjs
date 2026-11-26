// The shape check for a review body: one finding for every served hunk id, no missing, extra or repeated id.
// The way hunk ids sit in the patch is up to the caller.
export function checkFindings(body, servedIds) {
  const problems = [];
  if (!Array.isArray(servedIds) || servedIds.length === 0) return ['no served hunk ids: the patch was not read'];
  if (!body || typeof body !== 'object' || !Array.isArray(body.findings)) return ['the body has no findings array'];
  const extraTop = Object.keys(body).filter((k) => k !== 'findings');
  if (extraTop.length) problems.push(`unknown body fields: ${extraTop.join(', ')}`);
  const seen = new Set();
  for (const [i, f] of body.findings.entries()) {
    if (!f || typeof f !== 'object') { problems.push(`finding ${i} is not an object`); continue; }
    const extra = Object.keys(f).filter((k) => !['hunk', 'verdict', 'reason'].includes(k));
    if (extra.length) problems.push(`finding ${i} has unknown fields: ${extra.join(', ')}`);
    if (!servedIds.includes(f.hunk)) problems.push(`finding ${i} names a hunk that was not served: ${f.hunk}`);
    if (seen.has(f.hunk)) problems.push(`hunk ${f.hunk} has two findings`);
    seen.add(f.hunk);
    if (!['flag', 'pass'].includes(f.verdict)) problems.push(`finding ${i}: verdict must be flag or pass`);
    if (typeof f.reason !== 'string' || f.reason.trim() === '') problems.push(`finding ${i} has no reason`);
  }
  for (const id of servedIds) if (!seen.has(id)) problems.push(`no finding for hunk ${id}`);
  return problems;
}
