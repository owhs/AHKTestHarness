// Delta debugging (ddmin) + the trial runners used by `reduce` (script lines) and `replay`/`reduce actions` (smoke action logs).
import path from 'node:path';
import fs from 'node:fs';
import { Session } from '../session.mjs';
import { prepareTarget, buildOverlay } from '../overlay.mjs';
import { resolveAhk, ahkArgs, harvestAhkText, scriptNameOf } from '../adapters/ahk2.mjs';
import { perform } from './smoke.mjs';
import { sleep, readText, writeFile, AhkhError } from '../util.mjs';
import { Run } from '../evidence.mjs';

/** Complement-based ddmin: returns the smallest subset for which test() still returns true. */
export async function ddmin(items, test, { budgetMs = 300000, onStep } = {}) {
  const t0 = Date.now(); let cur = items.slice(); let n = 2; let trials = 0;
  while (cur.length >= 2 && Date.now() - t0 < budgetMs) {
    const size = Math.ceil(cur.length / n); let reduced = false;
    for (let i = 0; i < cur.length && Date.now() - t0 < budgetMs; i += size) {
      const comp = cur.slice(0, i).concat(cur.slice(i + size));
      if (!comp.length) continue;
      trials++;
      if (await test(comp)) { cur = comp; n = Math.max(n - 1, 2); reduced = true; onStep?.({ size: cur.length, trials }); break; }
    }
    if (!reduced) { if (n >= cur.length) break; n = Math.min(cur.length, n * 2); }
  }
  return { items: cur, trials, timedOut: Date.now() - t0 >= budgetMs };
}

const matcher = (rx) => { const re = rx ? new RegExp(rx, 'i') : null; return (f) => f.severity === 'error' && (!re || re.test(f.message)); };

/**
 * Reduce a script to the fewest LINES that still produce a finding matching `match` (regex on the message).
 * One hidden desktop is reused for every trial; the entry file is rewritten inside a shadow copy (originals untouched).
 */
export async function reduceScript(ctx, { script, match, budgetMs = 240000, timeout = 8, validate = true, onStep }) {
  const { exe } = resolveAhk(ctx.cfg, script);
  const run = new Run(ctx.cfg, { label: 'reduce-' + path.basename(script, '.ahk'), kind: 'reduce' });
  const built = buildOverlay({ cfg: ctx.cfg, run, script, ops: [] });
  const s = await Session.open(ctx, { label: 'reduce-trials', kind: 'reduce-trial' });
  const isMatch = matcher(match);
  const lines = readText(script).split(/\r?\n/);
  let n = 0; let target = null;   // signature of the ORIGINAL finding: a trial only counts if it reproduces that exact bug
  const trial = async (subset) => {
    writeFile(built.entry, subset.join('\n'));
    const name = 'r' + (++n); const before = s.run.findings.length;
    await s.launch({ name, exe, cwd: built.cwd, scriptName: path.basename(script), expect: 'exit', timeoutMs: timeout * 1000, args: ahkArgs({ script: built.entry, validate }) });
    await s.waitExit(name, timeout * 1000 + 3000, { soft: true });
    harvestAhkText(s, name);
    const errs = s.run.findings.slice(before).filter((f) => f.severity === 'error');
    let hit;
    if (target === null) { const f = errs.find(isMatch); hit = !!f; if (f) target = f.signature; }
    else hit = errs.some((f) => f.signature === target);
    await s.host.request('proc.dispose', { proc: name }).catch(() => {});
    return hit;
  };
  try {
    if (!(await trial(lines))) throw new AhkhError('the original script does not produce a finding matching --match; nothing to reduce', 'NOREPRO');
    const res = await ddmin(lines, trial, { budgetMs, onStep });
    writeFile(run.path('reduced.ahk'), res.items.join('\n') + '\n'); run.artifact('reduced', run.path('reduced.ahk'));
    return { original: lines.length, reduced: res.items.length, trials: res.trials, timedOut: res.timedOut, out: run.path('reduced.ahk'), text: res.items.join('\n'), runDir: run.dir };
  } finally { await s.close({ summary: 'reduce trials', verdict: 'PASS' }); run.finish({ verdict: 'PASS', summary: 'reduced' }); }
}

// ---------------------------------------------------------------------- action replay

/** Boot the script in a fresh shadow-copy session and replay actions; returns error findings produced. */
export async function replayActions(ctx, { script, actions, patch = [], unsafe = false, settleMs = 150, label = 'replay', keep = true }) {
  const { exe } = resolveAhk(ctx.cfg, script);
  const s = await Session.open(ctx, { label, kind: 'replay', keepGoing: true, rules: [{ name: 'msgbox-safe', match: { kind: 'msgbox' }, do: { shot: true, press: 'safe', verdict: 'dialog' } }] });
  let prepared;
  try {
    const p2 = [...patch]; if (!unsafe && !p2.includes('stub-dangerous')) p2.push('stub-dangerous');
    prepared = await prepareTarget(ctx, s, script, { patch: p2, probe: 'rpc', overlay: 'always', onError: 'log' });
    await s.launch({ name: 'main', exe, cwd: prepared.cwd, scriptName: scriptNameOf(script), expect: 'running', args: ahkArgs({ script: prepared.entry, includes: prepared.includes }), env: prepared.env });
    const p = s.proc('main'); const end = Date.now() + 8000;
    while (Date.now() < end && !p.exited && ![...s.windows.values()].some((w) => w.alive && w.visible && w.ready)) await sleep(50);
    await sleep(250);
    let done = 0; const errors = [];
    for (const act of actions) {
      if (p.exited) break;
      const mark = s.run.findings.length;
      try { await perform(s, act, null); } catch (e) { errors.push({ n: done + 1, message: e.message }); }
      await s.waitIdle({ quietMs: settleMs, timeout: 1500 }).catch(() => {});
      done++;
      for (const f of s.run.findings.slice(mark)) f.action = done;
    }
    harvestAhkText(s, 'main');
    return { session: s, findings: s.run.findings.filter((f) => f.severity === 'error'), done, prepared };
  } catch (e) { s.addFinding({ severity: 'error', kind: 'host-error', message: e.message }); return { session: s, findings: s.run.findings.filter((f) => f.severity === 'error'), done: 0, prepared }; }
}

export function loadActions(file) {
  return readText(file).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/** Reduce a smoke action log to the minimal click path that still reproduces a finding. */
export async function reduceActions(ctx, { script, actionsFile, match, budgetMs = 300000, onStep }) {
  const actions = loadActions(actionsFile);
  const isMatch = matcher(match);
  let trials = 0; let target = null;
  const test = async (subset) => {
    trials++;
    const r = await replayActions(ctx, { script, actions: subset, label: `reduce-trial-${trials}` });
    let hit;
    if (target === null) { const f = r.findings.find(isMatch); hit = !!f; if (f) target = f.signature; }
    else hit = r.findings.some((f) => f.signature === target);
    const dir = r.session.dir;
    if (r.prepared?.cleanup) await r.prepared.cleanup().catch(() => {});
    await r.session.close({ summary: 'trial' });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* keep on failure */ }
    return hit;
  };
  if (!(await test(actions))) throw new AhkhError('replaying the full action log does not reproduce a matching finding (timing-dependent bug, or wrong --match)', 'NOREPRO');
  const res = await ddmin(actions, test, { budgetMs, onStep });
  return { original: actions.length, reduced: res.items.length, actions: res.items, trials: res.trials, timedOut: res.timedOut };
}
