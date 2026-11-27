// Checks a plan before we approve its POST (the board contract plus our own rules), and turns the plan as read back
// from the board into the file lists post-check.mjs reads.
//   node /harness/plan-check.mjs check <held plan body> --models "worker=<id>,integrator=<id>"
//   node /harness/plan-check.mjs lists <board reply or plan> <setup commit> <output plan.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REQUESTS = ['r1', 'r2', 'r3', 'merge'];
const BANNED = /(^|\/)(journal|out|night|node_modules|\.git)(\/|$)|(^|\/)(vars\.json|parked\.json|\.env[^/]*)$|\.(pem|key)$/i;
// What guards the team: no job may plan a change to it.
const OURS = /^\.gitignore$|^roles\/[^/]+\/(run\.mjs|hosts\.json)$|^roles\/[^/]+\/extensions\/|^roles\/(critic|planner|worker|integrator)\/scripts\//i;

export function checkPlan(plan, models) {
  const problems = [];
  const jobs = Array.isArray(plan?.jobs) ? plan.jobs : [];
  if (jobs.length < 1 || jobs.length > 12) problems.push('a plan has 1 to 12 jobs');
  const ids = new Set();
  const owners = new Map(); // file -> id of the job that lists it
  for (const j of jobs) {
    const id = String(j?.id ?? '');
    if (!ID.test(id)) problems.push(`job id "${id}": letters, digits, - and _ only`);
    if (ids.has(id)) problems.push(`job id ${id} is used twice`);
    ids.add(id);
    if (!REQUESTS.includes(j.request)) problems.push(`${id}: request must be one of ${REQUESTS.join(', ')}`);
    const owner = j.request === 'merge' ? 'integrator' : 'worker';
    if (j.owner !== owner) problems.push(`${id}: owner must be ${owner}`);
    else if (!models[owner] || j.model !== models[owner]) problems.push(`${id}: model is not the one chosen for ${owner}`);
    const files = Array.isArray(j.files) ? j.files : [];
    if (files.length < 1 || files.length > 40) problems.push(`${id}: a job lists 1 to 40 files`);
    for (const f of files) {
      if (typeof f !== 'string' || f.length > 300 || /^\/|\\|\s|"|(^|\/)\.\.(\/|$)/.test(f) || BANNED.test(f)) problems.push(`${id}: file path not allowed: ${String(f).slice(0, 80)}`);
      else if (OURS.test(f)) problems.push(`${id}: this file may not be in a plan: ${f}`);
      // The course refuses a plan with a file in two jobs, the merge job included (422, S04E03, 2026-11-26).
      if (owners.has(f) && owners.get(f) !== id) problems.push(`shared by ${owners.get(f)} and ${id}: ${f}`);
      owners.set(f, id);
    }
    const asks = j.asks ?? [];
    if (!Array.isArray(asks) || asks.length > 20 || asks.some((a) => typeof a !== 'string' || a.length > 300)) problems.push(`${id}: asks are up to 20 lines of up to 300 characters`);
  }
  for (const r of ['r1', 'r2', 'r3']) if (!jobs.some((j) => j.request === r)) problems.push(`${r} is not served by any job`);
  if (jobs.filter((j) => j.request === 'merge').length !== 1) problems.push('there must be exactly one merge job');
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, input, ...rest] = process.argv.slice(2);
  const read = () => JSON.parse(readFileSync(input, 'utf8'));
  if (command === 'check') {
    const list = rest[rest.indexOf('--models') + 1] ?? '';
    const models = Object.fromEntries(list.split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
    const problems = checkPlan(read(), models);
    console.log(problems.length ? `plan-check FAIL:\n- ${problems.join('\n- ')}` : 'plan-check ok');
    process.exit(problems.length ? 1 : 0);
  } else if (command === 'lists') {
    const [setupCommit, output] = rest;
    const data = read();
    const jobs = data.plan?.jobs ?? data.jobs;
    if (!/^[0-9a-f]{7,40}$/.test(setupCommit ?? '') || !Array.isArray(jobs) || !jobs.length || !output) {
      console.error('usage: lists <board reply or plan> <setup commit> <output>; the input must hold plan.jobs or jobs');
      process.exit(1);
    }
    writeFileSync(output, JSON.stringify({ setupCommit, jobs: jobs.map(({ id, request, files }) => ({ id, request, files })) }, null, 2) + '\n');
    console.log(`wrote the file lists of ${jobs.length} jobs`);
  } else {
    console.error('usage: plan-check.mjs check|lists ...');
    process.exit(1);
  }
}
