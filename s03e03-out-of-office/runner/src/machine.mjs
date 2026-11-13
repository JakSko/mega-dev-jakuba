// The state machine: one issue at a time, fixed steps, every outside effect done here in code.
// The model only decides (JSON) and edits files; it never posts, deploys or pushes.
import { runGates } from './gates.mjs';
import { sleep } from './lib.mjs';

const VERBS = new Set(['build', 'decline', 'ask', 'close', 'none']);
const KINDS = new Set(['decline', 'smaller', 'full']);
const CONTRACT_PRIMS = /^P[1-5]$/;

export const shipLine = (n, verb, live, risks) =>
  `#${n} · ${verb} · live: ${live ? '✓' : '✗'} · open risks: ${risks}`;

const oneLine = (s) => typeof s === 'string' && s.trim() && !/[\n·]/.test(s);
const okChecks = (list) => Array.isArray(list) && list.length > 0 &&
  list.every((c) => typeof c.path === 'string' && c.path.startsWith('/') && Number.isInteger(c.status) && Array.isArray(c.includes));

/** Code-side check of a decision. The model proposes; these rules decide if it may be carried out. */
export function validateDecision(d, { n, followup = false, records = [] }) {
  const e = [];
  if (!d || typeof d !== 'object') return ['the decision is not an object'];
  if (!VERBS.has(d.verb)) e.push('verb must be build, decline, ask, close or none');
  // An accepted, signed record binds: what it decided is not asked again and not built against.
  const binding = records.find((r) => d.decidedBy && r.id === d.decidedBy && r.status === 'accepted' && r.signedBy);
  if (d.decidedBy && !binding && d.verb !== 'none') e.push(`decidedBy names "${d.decidedBy}", which is not an accepted, signed record: leave decidedBy empty (an unsigned record is evidence, so the call goes to the owner)`);
  if (binding && (d.verb === 'ask' || d.verb === 'build')) e.push(`record ${binding.id} is accepted and signed, so it already decides this: decline and cite it; do not ask the owner again and do not build against it`);
  if (d.verb === 'none') return followup ? e : ['"none" is only for a follow-up on an issue that already has a ship line'];
  if (!d.reason?.trim()) e.push('reason is empty');
  if (!Array.isArray(d.cites) || !d.cites.length) e.push('cites is empty: every decision rests on a rule id');
  if (!d.comment?.trim() || d.comment.length > 2000) e.push('comment is empty or longer than 2000 characters');
  if (!oneLine(d.openRisks)) e.push('openRisks must be one line with no "·": "none" or the issue id plus who reads it');
  const touches = Array.isArray(d.touches) ? d.touches : [];
  if (touches.some((t) => t.primitive === 'P7')) {
    if (d.verb !== 'decline') e.push('anything that touches P7 (feed writes, the admin token) is declined, never built or asked');
  }
  if (d.verb === 'build') {
    if (!d.brief?.trim()) e.push('build needs a brief');
    if (!okChecks(d.liveChecks)) e.push('build needs liveChecks: path starting with /, status, includes');
    if (touches.some((t) => CONTRACT_PRIMS.test(t.primitive) && (t.how === 'changes' || t.how === 'removes')))
      e.push('a change to what an existing answer carries (P1-P5 changes/removes) needs the owner: ask, do not build');
  }
  if (d.verb === 'ask') {
    if (!d.question?.trim()) e.push('ask needs a question');
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.record?.slug ?? '') || d.record.slug.length > 40) e.push('record.slug must be lower-case-words');
    const text = d.record?.text ?? '';
    if (!/^status:\s*proposed\b/m.test(text)) e.push('the record must have "status: proposed"');
    if (!new RegExp(`^issue:\\s*#?${n}\\b`, 'm').test(text)) e.push(`the record must have "issue: ${n}"`);
    for (const h of ['## Ask', '## Options', '## Cost of being wrong', '## Reversibility', '## Success metric', '## Reopen threshold', '## Decision'])
      if (!text.includes(h)) e.push(`the record lacks the section "${h}"`);
    const o = Array.isArray(d.options) ? d.options : [];
    if (o.length < 2) e.push('ask needs two or more options');
    o.forEach((x, i) => {
      if (x.n !== i + 1) e.push('options are numbered 1, 2, 3 in order');
      if (!KINDS.has(x.kind)) e.push(`option ${i + 1}: kind must be decline, smaller or full`);
      if (!x.text?.trim()) e.push(`option ${i + 1}: text is empty`);
      if (x.kind !== 'decline' && (!x.brief?.trim() || !okChecks(x.liveChecks))) e.push(`option ${i + 1}: a built option needs its brief and liveChecks`);
      if (!new RegExp(`kind:\\s*${x.kind}`).test(text)) e.push(`the record text does not tag an option "kind: ${x.kind}"`);
    });
    if (!o.some((x) => x.kind === 'decline')) e.push('always offer a decline option');
    if (!(d.recommendation >= 1 && d.recommendation <= o.length)) e.push('recommendation must be an option number');
  }
  return e;
}

export function nextRecordId(records, slug) {
  const nums = records.map((r) => parseInt(String(r.id).slice(0, 4), 10)).filter(Number.isFinite);
  return `${String(Math.max(6, ...nums) + 1).padStart(4, '0')}-${slug}`;
}

const proposedText = (text, id) => text
  .replace(/^id:.*$/m, `id: ${id.slice(0, 4)}`)
  .replace(/^signed-by:.*$/m, 'signed-by: # the tracker fills this in when the owner signs');

const acceptedText = (text, opt, n, at) => text
  .replace(/^status:.*$/m, 'status: accepted')
  .replace(/## Decision[\s\S]*$/, `## Decision\nOption ${opt.n} (kind: ${opt.kind}): ${opt.text}\nChosen by the owner in issue #${n} with "/answer ${opt.n}", at ${at}.\n`);

export class Runner {
  constructor(deps) {
    // deps: cfg, tracker, state, agent, deployer, notify, git, out, log
    Object.assign(this, deps);
    this.busy = false;
    this.working = Promise.resolve();
    this.last = null;
  }
  get S() { return this.state.get(); }

  /** One poll. Pickup happens here, at once, and never waits for the build queue or a model. */
  async cycle() {
    let data;
    try { data = await this.tracker.issues(); } catch (err) { this.log('poll-failed', { err: err.message }); return; }
    this.last = data;
    for (const is of data.issues) {
      const st = this.S.issues[is.n];
      if (!st) { await this.pickup(is); continue; }
      if (st.phase === 'asked' && this.answers(st, is).length) st.phase = 'answered';
      else if (st.phase === 'done' && is.thread.length > st.seen && st.retriage < 2 &&
        is.thread.slice(st.seen).some((t) => t.by !== 'agent')) {
        st.phase = 'queued'; st.retriage += 1; st.followup = true;
        this.log('follow-up', { n: is.n });
      }
    }
    this.state.save();
    this.kick();
    await this.roundEnd(data).catch((err) => this.log('round-end-failed', { err: err.message }));
  }

  async pickup(is) {
    try {
      if (!is.thread.some((t) => t.by === 'agent')) await this.tracker.comment(is.n, `Picked up #${is.n}: reading it now.`);
      const back = await this.tracker.issue(is.n);
      const mine = back.thread.find((t) => t.by === 'agent');
      if (!mine) throw new Error('the pickup comment is not on the tracker');
      this.S.issues[is.n] = { n: is.n, title: is.title, openedAt: is.openedAt, pickedAt: mine.at, phase: 'queued', seen: back.thread.length, retriage: 0, errors: 0, steps: {} };
      this.log('pickup', { n: is.n, openedAt: is.openedAt, pickedAt: mine.at });
    } catch (err) {
      this.log('pickup-failed', { n: is.n, err: err.message });
    }
    this.state.save();
  }

  answers(st, is) {
    return is.thread.slice(st.askIdx ?? 0)
      .filter((t) => t.by === 'owner' && t.kind === 'comment')
      .map((t) => ({ m: /^\s*\/answer\s+(\S+)/m.exec(t.body ?? ''), at: t.at }))
      .filter((x) => x.m).map((x) => ({ raw: x.m[1], at: x.at }));
  }

  /** The build queue: one issue at a time, oldest first. */
  kick() {
    if (this.busy) return;
    this.busy = true;
    this.working = (async () => {
      try {
        for (;;) {
          const st = Object.values(this.S.issues)
            .filter((x) => x.phase === 'queued' || x.phase === 'answered')
            .sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)) || a.n - b.n)[0];
          if (!st) break;
          try {
            await this.process(st);
          } catch (err) {
            st.errors += 1;
            this.log('process-failed', { n: st.n, errors: st.errors, err: err.message });
            if (st.errors >= 3) await this.giveUp(st, `stopped after three errors: ${err.message.slice(0, 200)}`).catch((e) => { st.phase = 'stuck'; this.log('give-up-failed', { n: st.n, err: e.message }); });
            else await sleep(this.cfg.retryMs ?? 5000);
          }
          this.state.save();
        }
      } finally { this.busy = false; }
    })();
  }

  /** Do a step with an outside effect once, even if the process restarts in the middle. */
  async once(st, key, fn) {
    const k = `${st.retriage}:${key}`;
    if (st.steps[k]) return;
    await fn();
    st.steps[k] = true;
    this.state.save();
  }

  spend() {
    this.S.modelCalls += 1;
    if (this.S.modelCalls > this.cfg.maxModelCalls) throw new Error('the model budget for this round is spent');
  }

  async process(st) {
    const is = await this.tracker.issue(st.n);
    if (st.phase === 'answered') return this.onAnswer(st, is);

    const { records } = await this.tracker.records();
    const { text: shiplog } = await this.tracker.shiplog();
    // Real incidents from the live address, so live checks can name ids and values that exist.
    let liveSample = [];
    try { liveSample = (await this.out(`${this.cfg.liveUrl}/incidents`)).json().incidents.slice(0, 6); } catch { /* the sample is a help, not a need */ }
    const ctx = {
      liveSample,
      issue: is, records, shiplog, followup: !!st.followup,
      previous: st.final ? { verb: st.final, line: st.line, reason: st.decision?.reason } : null,
      otherIssues: (this.last?.issues ?? []).filter((o) => o.n !== is.n).map((o) => ({
        n: o.n, title: o.title, body: o.body, openedAt: o.openedAt, closed: o.closed, labels: o.labels,
        ours: this.S.issues[o.n]?.final ?? 'not decided yet',
      })),
    };
    let d; let errs = [];
    for (let i = 0; i < 2; i++) {
      this.spend();
      d = await this.agent.triage(ctx, errs);
      errs = validateDecision(d, { n: st.n, followup: !!st.followup, records });
      if (!errs.length) break;
      this.log('decision-refused', { n: st.n, errs });
    }
    if (errs.length) return this.giveUp(st, `no decision passed the rules: ${errs[0]}`);
    st.decision = { verb: d.verb, reason: d.reason, cites: d.cites, touches: d.touches, openRisks: d.openRisks };
    this.log('decision', { n: st.n, ...st.decision });

    if (d.verb === 'none') { st.phase = 'done'; st.followup = false; st.seen = is.thread.length; return; }
    if (d.verb === 'decline') {
      await this.once(st, 'comment', () => this.tracker.comment(st.n, d.comment));
      return this.finish(st, 'declined', false, d.openRisks);
    }
    if (d.verb === 'close') {
      await this.once(st, 'comment', () => this.tracker.comment(st.n, d.comment));
      await this.once(st, 'close', () => this.tracker.close(st.n));
      return this.finish(st, 'closed', false, d.openRisks);
    }
    if (d.verb === 'ask') {
      st.recordId ??= nextRecordId(records, d.record.slug);
      st.recordText ??= proposedText(d.record.text, st.recordId);
      st.options = d.options;
      this.state.save();
      await this.once(st, 'record', () => this.tracker.putRecord(st.recordId, st.recordText));
      await this.once(st, 'label', () => this.tracker.label(st.n, 'needs-human'));
      const lines = d.options.map((o) => `${o.n}. ${o.text} (kind: ${o.kind})`).join('\n');
      await this.once(st, 'ask', () => this.tracker.comment(st.n,
        `This is the owner's call (record ${st.recordId}).\n${d.question}\n\nOptions:\n${lines}\n\nRecommendation: ${d.recommendation}, because ${d.recommendationWhy}\n\nAnswer in this issue with /answer <n>.`));
      await this.finish(st, 'asked', false, d.openRisks);
      await this.notify(`#${st.n} needs your answer`, `${d.question} Answer /answer <n> on the round page.`);
      return;
    }
    return this.build(st, is, { brief: d.brief, liveChecks: d.liveChecks, comment: d.comment, risks: d.openRisks, touches: d.touches, allowContract: false });
  }

  async onAnswer(st, is) {
    const all = this.answers(st, is);
    const valid = [...new Set(all.map((a) => a.raw).filter((r) => st.options.some((o) => String(o.n) === r)))];
    const markRead = async () => { st.askIdx = (await this.tracker.issue(st.n)).thread.length; st.phase = 'asked'; };
    if (valid.length !== 1) {
      const why = valid.length ? `I see more than one answer (${valid.join(', ')})` : `"${all.map((a) => a.raw).join(', ')}" is not one of the options`;
      await this.tracker.comment(st.n, `${why}. Please answer once with /answer <n>, where n is 1 to ${st.options.length}.`);
      this.log('answer-refused', { n: st.n, answers: all.map((a) => a.raw) });
      return markRead();
    }
    const opt = st.options.find((o) => String(o.n) === valid[0]);
    const at = all.find((a) => a.raw === valid[0]).at;
    this.log('answer', { n: st.n, option: opt.n, optionKind: opt.kind, answeredAt: at });
    const k = `a${opt.n}`;
    await this.once(st, `${k}:accept`, () => this.tracker.putRecord(st.recordId, acceptedText(st.recordText, opt, st.n, at)));
    const sign = `Record ${st.recordId} is accepted. Please sign it on your round page.`;
    if (opt.kind === 'decline') {
      await this.once(st, `${k}:comment`, () => this.tracker.comment(st.n, `The owner chose option ${opt.n} (decline): nothing is built. ${sign}`));
      return this.finish(st, 'declined', false, 'none');
    }
    return this.build(st, is, {
      brief: `${opt.text}\n\n${opt.brief}`, liveChecks: opt.liveChecks, touches: st.decision?.touches ?? [],
      comment: `Built option ${opt.n} (${opt.kind}), as the owner decided in record ${st.recordId}. ${sign}`,
      risks: st.decision?.openRisks ?? 'none', allowContract: true, key: k,
    });
  }

  async build(st, is, o) {
    const key = o.key ?? 'b';
    if (!st.steps[`${st.retriage}:${key}:deployed`]) {
      const base = this.git.head();
      let feedback = ''; let passed = false;
      for (let i = 0; i < 3 && !passed; i++) {
        this.git.reset(base);
        this.spend();
        await this.agent.build({ issue: is, brief: o.brief, feedback, allowContract: o.allowContract });
        const g = runGates(this.cfg.work, { base, allowContract: o.allowContract });
        this.log('gates', { n: st.n, try: i + 1, ok: g.ok, why: g.why });
        if (!g.ok) { feedback = `A gate failed: ${g.why}\n${g.output}`.slice(0, 6000); continue; }
        this.spend();
        const r = await this.agent.review({ issue: is, brief: o.brief, diff: this.git.diff(), touches: o.touches, allowContract: o.allowContract });
        this.log('review', { n: st.n, try: i + 1, verdict: r.verdict, reasons: r.reasons });
        if (r.verdict !== 'pass') { feedback = `The reviewer blocked it: ${(r.reasons ?? []).join('; ')}`.slice(0, 6000); continue; }
        passed = true;
      }
      if (!passed) { this.git.reset(base); return this.giveUp(st, `it did not pass the gates. ${feedback.split('\n')[0]}`, o.risks); }

      const recap = (o.touches ?? []).map((t) => `${t.primitive} ${t.how}`).join(', ') || 'none';
      const commit = this.git.commit(`#${st.n} ${is.title}\n\nRecap: #${st.n}\nTouches: ${recap}\nRecord: ${st.recordId ?? 'none (additive)'}\n`);
      const dep = await this.deployer.deploy();
      this.log('deploy', { n: st.n, commit, ok: dep.ok, version: dep.versionId, note: dep.note });
      const live = dep.ok && await this.liveOk(o.liveChecks);
      if (!live) {
        const back = this.git.revert();
        const rb = await this.deployer.deploy();
        const still = rb.ok && await this.liveOk([]);
        this.log('rollback', { n: st.n, to: back, ok: rb.ok, liveAfter: still });
        return this.giveUp(st, 'the change did not answer on the live address, so it was rolled back', o.risks);
      }
      st.commit = commit; st.version = dep.versionId; this.S.lastGood = commit;
      st.steps[`${st.retriage}:${key}:deployed`] = true;
      this.state.save();
      this.log('pushed', { n: st.n, ok: this.git.push() });
    }
    const paths = o.liveChecks.map((c) => c.path).join(', ');
    await this.once(st, `${key}:shipped-comment`, () => this.tracker.comment(st.n, `${o.comment}\nLive now: ${paths}`));
    return this.finish(st, 'shipped', true, o.risks);
  }

  /** Live means it answers on the live address: read twice, the second time after a lag. */
  async liveOk(checks) {
    const all = [
      { path: '/incidents', status: 200, includes: ['"incidents"'] },
      { path: '/__nothing-here', status: 404, includes: ['not found'] },
      ...checks,
    ];
    for (let round = 0; round < 2; round++) {
      // Wait before the first read too: right after a deploy the edge can still answer the old version.
      await sleep(round ? this.cfg.lagMs : Math.min(this.cfg.lagMs, 4000));
      for (const c of all) {
        let r;
        try { r = await this.out(this.cfg.liveUrl + c.path); } catch (err) { this.log('live-check', { path: c.path, ok: false, err: err.message }); return false; }
        let isJson = true; try { JSON.parse(r.text); } catch { isJson = false; }
        const ok = r.status === c.status && isJson && c.includes.every((s) => r.text.includes(s));
        this.log('live-check', { path: c.path, round: round + 1, status: r.status, ok });
        if (!ok) return false;
      }
    }
    return true;
  }

  async giveUp(st, why, risks) {
    await this.once(st, 'gave-up', () => this.tracker.comment(st.n, `Not shipped: ${why}. Nothing changed on the live address.`));
    await this.finish(st, 'waiting', false, risks && risks !== 'none' ? risks : `#${st.n} the owner`);
    await this.notify(`#${st.n} was not shipped`, why);
  }

  /** One ship line per issue, read back from the tracker before the issue counts as done. */
  async finish(st, verb, live, risks) {
    const line = shipLine(st.n, verb, live, risks);
    await this.tracker.ship(line);
    const { text } = await this.tracker.shiplog();
    if (!text.split('\n').map((l) => l.trim()).includes(line)) throw new Error(`the ship log does not show: ${line}`);
    const back = await this.tracker.issue(st.n);
    st.line = line; st.final = verb; st.followup = false; st.errors = 0;
    st.seen = back.thread.length;
    if (verb === 'asked') { st.phase = 'asked'; st.askIdx = back.thread.length; } else st.phase = 'done';
    this.log('ship-line', { n: st.n, line });
    this.state.save();
  }

  async roundEnd(data) {
    if (!data.lastIssueBy || Date.parse(data.now) <= Date.parse(data.lastIssueBy)) return;
    const sts = data.issues.map((i) => this.S.issues[i.n]);
    // Delivered is a named set of outcomes. An issue that ended as "waiting" is not delivered.
    if (!sts.length || sts.some((s) => !s || s.phase !== 'done' || !['shipped', 'declined', 'closed'].includes(s.final))) return;
    const { records } = await this.tracker.records();
    const unsigned = records.filter((r) => r.by === 'agent' && r.status === 'accepted' && !r.signedBy).map((r) => r.id);
    const N = this.S.notified;
    if (unsigned.length) {
      if (N.sign !== unsigned.join()) { N.sign = unsigned.join(); await this.notify('Records wait for your signature', `Sign on the round page: ${unsigned.join(', ')}`); }
    } else if (!N.end) {
      N.end = true;
      this.log('round-complete', { issues: sts.length });
      await this.notify('Round complete', `All ${sts.length} issues have a ship line and every record is signed. Ready to claim.`);
    }
    this.state.save();
  }
}
