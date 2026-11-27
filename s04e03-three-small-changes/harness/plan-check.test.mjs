// Tests for plan-check.mjs. Run in course-box: node --test plan-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan } from './plan-check.mjs';

const MODELS = { worker: 'openai/m-w', integrator: 'openai/m-i' };
const job = (id, request, files, over = {}) => ({ id, owner: request === 'merge' ? 'integrator' : 'worker', files, request, model: request === 'merge' ? 'openai/m-i' : 'openai/m-w', ...over });
const good = () => ({ jobs: [job('w-1', 'r1', ['a.js'], { asks: ['keep b (r1)'] }), job('w-2', 'r2', ['b.js']), job('w-3', 'r3', ['c.js']), job('merge-1', 'merge', ['d.js'])] });
const problems = (change) => {
  const plan = good();
  change(plan);
  return checkPlan(plan, MODELS).join(' | ');
};

test('a good plan passes; the course refuses a file in two jobs, the merge job included', () => {
  assert.deepEqual(checkPlan(good(), MODELS), []);
  assert.match(problems((p) => p.jobs[3].files.push('a.js')), /shared by w-1 and merge-1: a\.js/);
});

test('coverage and the one merge job', () => {
  assert.match(problems((p) => p.jobs.splice(2, 1)), /r3 is not served/);
  assert.match(problems((p) => p.jobs.push(job('m-2', 'merge', ['e.js']))), /exactly one merge job/);
  assert.match(problems((p) => p.jobs.splice(3, 1)), /exactly one merge job/);
  assert.match(problems((p) => (p.jobs = [])), /1 to 12 jobs/);
});

test('ids, owners and models', () => {
  assert.match(problems((p) => (p.jobs[1].id = 'w-1')), /used twice/);
  assert.match(problems((p) => (p.jobs[1].id = 'w 2')), /job id/);
  assert.match(problems((p) => (p.jobs[1].owner = 'builder')), /owner/);
  assert.match(problems((p) => (p.jobs[3].owner = 'worker')), /owner/);
  assert.match(problems((p) => (p.jobs[0].model = 'openai/other')), /model/);
  assert.match(problems((p) => (p.jobs[0].request = 'r4')), /request/);
});

test('files: shared between jobs, banned, odd, empty, too many', () => {
  assert.match(problems((p) => (p.jobs[1].files = ['a.js'])), /shared by w-1 and w-2: a\.js/);
  for (const f of ['vars.json', 'journal/x', 'roles/reviewer/out/a', '.env', 'k.pem', 'night/a', '/etc/x', '../x', 'a b.js', 'a\\b.js']) {
    assert.match(problems((p) => (p.jobs[2].files = [f])), /file path/, f);
  }
  assert.match(problems((p) => (p.jobs[2].files = [])), /1 to 40 files/);
  assert.match(problems((p) => (p.jobs[2].files = Array.from({ length: 41 }, (_, i) => `f${i}`))), /1 to 40 files/);
});

test('files a job may never plan: the team tools and hosts', () => {
  for (const f of ['roles/worker/run.mjs', 'roles/worker/extensions/http.mjs', 'roles/integrator/scripts/post-result.mjs', 'roles/planner/hosts.json', '.gitignore']) {
    assert.match(problems((p) => (p.jobs[2].files = [f])), /may not be in a plan/, f);
  }
});

test('asks: at most 20 lines of at most 300 characters', () => {
  assert.match(problems((p) => (p.jobs[0].asks = Array(21).fill('x'))), /asks/);
  assert.match(problems((p) => (p.jobs[0].asks = ['x'.repeat(301)])), /asks/);
});
