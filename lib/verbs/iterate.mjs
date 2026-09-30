// Iteration verbs: repeat (flake detection), matrix, bench, replay, reduce, trace, ast.*
import path from 'node:path';
import fs from 'node:fs';
import { defineVerb, VERBS } from './registry.mjs';
import { Session } from '../session.mjs';
import { resolveAhk, ahkArgs, assertScript, harvestAhkText, scriptNameOf } from '../adapters/ahk2.mjs';
import { prepareTarget, buildOverlay } from '../overlay.mjs';
import { reduceScript, reduceActions, replayActions, loadActions } from '../modules/reduce.mjs';
import { AstClient, renderOutline, withAst } from '../modules/ast.mjs';
import { formatRun } from './run.mjs';
import { Run, VERDICT_EXIT } from '../evidence.mjs';
import { findAhk } from '../config.mjs';
import { expandPaths, sleep, readText, writeFile, writeJson, truncate, fmtMs, AhkhError, exists, ensureDir } from '../util.mjs';

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------------------------------------------------------------------- repeat / matrix

defineVerb({
  name: 'repeat', group: 'iterate', local: true,
  desc: 'Run a script N times and report the verdict distribution (flake detection).',
  args: { script: { type: 'string', positional: 0, required: true }, count: { type: 'number', default: 5 }, for: { type: 'number' }, timeout: { type: 'number' }, stopOnFail: { type: 'boolean' }, probe: { type: 'boolean' }, patch: { type: 'array' } },
  async run(ctx, a) {
    const tally = {}; const runs = [];
    for (let i = 0; i < a.count; i++) {
      const r = await VERBS.get('run').run(ctx, { script: a.script, for: a.for, timeout: a.timeout, probe: a.probe, patch: a.patch, label: `repeat${i + 1}`, noFinalShot: true });
      tally[r.verdict] = (tally[r.verdict] || 0) + 1; runs.push({ n: i + 1, verdict: r.verdict, run: path.basename(r.runDir) });
      if (a.stopOnFail && r.verdict !== 'PASS') break;
    }
    const fails = Object.entries(tally).filter(([v]) => v !== 'PASS').reduce((n, [, c]) => n + c, 0);
    const flaky = fails > 0 && tally.PASS > 0;
    const verdict = fails ? 'FAIL' : 'PASS';
    return { verdict, summary: `${flaky ? 'FLAKY' : verdict}  repeat  ${runs.length} run(s): ${Object.entries(tally).map(([v, c]) => `${v}×${c}`).join(' ')}${flaky ? `  (flake rate ${Math.round(100 * fails / runs.length)}%)` : ''}\n${runs.map((r) => `  #${r.n} ${r.verdict} ${r.run}`).join('\n')}`, data: { tally, runs, flaky }, exitCode: fails ? 1 : 0 };
  },
});

defineVerb({
  name: 'matrix', group: 'iterate', local: true,
  desc: 'Run a script across a matrix: AutoHotkey exes / bitness × environment variants × argument sets. Reports each cell.',
  args: {
    script: { type: 'string', positional: 0, required: true }, ahk: { type: 'array', desc: 'AutoHotkey exe paths to compare' }, env: { type: 'json', desc: 'JSON array of env objects, e.g. [{"LANG":"de"},{"LANG":"ja"}]' },
    argsets: { type: 'json', desc: 'JSON array of argument arrays' }, for: { type: 'number' }, timeout: { type: 'number', default: 15 },
  },
  async run(ctx, a) {
    const script = assertScript(path.resolve(ctx.cwd, a.script));
    const exes = a.ahk?.length ? a.ahk : [findAhk(ctx.cfg)].concat(['C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey32.exe'].filter((p) => exists(p) && p !== findAhk(ctx.cfg)));
    const envs = a.env?.length ? a.env : [{}]; const argsets = a.argsets?.length ? a.argsets : [[]];
    const cells = [];
    for (const exe of exes) for (const env of envs) for (const args of argsets) {
      const saved = ctx.cfg.ahk; ctx.cfg.ahk = { ...ctx.cfg.ahk, exe };
      try { const r = await VERBS.get('run').run(ctx, { script, for: a.for, timeout: a.timeout, env, args, label: 'matrix', noFinalShot: true }); cells.push({ exe: path.basename(exe), env, args, verdict: r.verdict, run: path.basename(r.runDir) }); }
      finally { ctx.cfg.ahk = saved; }
    }
    const bad = cells.filter((c) => c.verdict !== 'PASS');
    return { verdict: bad.length ? 'FAIL' : 'PASS', summary: `${bad.length ? 'FAIL' : 'PASS'}  matrix  ${cells.length} cell(s), ${bad.length} failing\n${cells.map((c) => `  ${c.verdict.padEnd(8)} ${c.exe} env=${JSON.stringify(c.env)} args=${JSON.stringify(c.args)}  ${c.run}`).join('\n')}`, data: { cells }, exitCode: bad.length ? 1 : 0 };
  },
});

// ---------------------------------------------------------------------- bench

defineVerb({
  name: 'bench', group: 'iterate', local: true,
  desc: 'Startup/health benchmark: N runs -> time to first window, time to idle, memory, plus any Ahkh.Bench()/AHKH|bench lines the script prints. Median/min/max.',
  args: { script: { type: 'string', positional: 0, required: true }, runs: { type: 'number', default: 5 }, for: { type: 'number', default: 3, desc: 'seconds to observe each run' }, csv: { type: 'string', desc: 'append results to this CSV' } },
  async run(ctx, a) {
    const script = assertScript(path.resolve(ctx.cwd, a.script)); const { exe } = resolveAhk(ctx.cfg, script);
    const samples = []; const benchLines = new Map();
    for (let i = 0; i < a.runs; i++) {
      const s = await Session.open(ctx, { label: `bench${i + 1}`, kind: 'bench' });
      try {
        const prep = await prepareTarget(ctx, s, script, { probe: 'passive' });
        const t0 = performance.now();
        await s.launch({ name: 'main', exe, cwd: prep.cwd, scriptName: scriptNameOf(script), expect: 'running', args: ahkArgs({ script: prep.entry, includes: prep.includes }), env: prep.env });
        let tWin = null; const p = s.proc('main');
        while (performance.now() - t0 < a.for * 1000 && !p.exited) { if (tWin === null && [...s.windows.values()].some((w) => w.visible)) tWin = performance.now() - t0; await sleep(15); }
        await s.waitIdle({ quietMs: 300, timeout: 4000 }).catch(() => {});
        const idle = Math.max(0, s.lastActivity - t0);   // when the last window/output/dialog event happened, relative to launch
        const m = await s.metrics('main').catch(() => null);
        const ws = m ? m.processes.reduce((x, y) => x + y.workingSetMB, 0) : null, handles = m ? m.processes.reduce((x, y) => x + y.handles, 0) : null, cpu = m ? m.processes.reduce((x, y) => x + y.cpuMs, 0) : null;
        for (const l of [...p.out]) { const mm = /^AHKH\|bench\|(.*)$/.exec(l); if (mm) { try { const d = JSON.parse(mm[1]); const k = d.label; if (!benchLines.has(k)) benchLines.set(k, []); benchLines.get(k).push(d.usPerOp ?? d.ms); } catch { /* ignore */ } } }
        samples.push({ firstWindowMs: tWin, idleMs: idle, workingSetMB: ws, handles, cpuMs: cpu, exited: p.exited });
      } finally { await s.close({ summary: 'bench sample' }); }
    }
    const col = (k) => samples.map((x) => x[k]).filter((v) => v != null);
    const fmt = (k, unit = '') => { const v = col(k); return v.length ? `median ${median(v).toFixed(1)}${unit}  (min ${Math.min(...v).toFixed(1)}, max ${Math.max(...v).toFixed(1)}, n=${v.length})` : 'n/a'; };
    const L = [`bench  ${path.basename(script)}  ${samples.length} run(s)`, `  first window : ${fmt('firstWindowMs', 'ms')}`, `  idle         : ${fmt('idleMs', 'ms')}`, `  working set  : ${fmt('workingSetMB', 'MB')}`, `  handles      : ${fmt('handles')}`, `  cpu          : ${fmt('cpuMs', 'ms')}`];
    for (const [k, v] of benchLines) L.push(`  ${k}: median ${median(v).toFixed(3)}`);
    if (a.csv) { const f = path.resolve(ctx.cwd, a.csv); if (!exists(f)) writeFile(f, 'time,script,firstWindowMs,idleMs,workingSetMB,handles,cpuMs\n'); for (const x of samples) fs.appendFileSync(f, [new Date().toISOString(), path.basename(script), x.firstWindowMs?.toFixed(1), x.idleMs?.toFixed(1), x.workingSetMB, x.handles, x.cpuMs].join(',') + '\n'); }
    return { ok: true, summary: L.join('\n'), data: { samples, bench: Object.fromEntries([...benchLines].map(([k, v]) => [k, { median: median(v), samples: v }])) } };
  },
});

// ---------------------------------------------------------------------- replay / reduce

defineVerb({
  name: 'replay', group: 'iterate', local: true, desc: 'Replay a smoke action log (smoke-actions.jsonl) against a script in a fresh session.',
  args: { script: { type: 'string', positional: 0, required: true }, actions: { type: 'string', required: true, desc: 'path to smoke-actions.jsonl (or a run name)' }, unsafe: { type: 'boolean' } },
  async run(ctx, a) {
    const script = assertScript(path.resolve(ctx.cwd, a.script));
    let file = path.resolve(ctx.cwd, a.actions); if (!exists(file)) file = path.join(ctx.cfg.outDir, a.actions, 'smoke-actions.jsonl');
    const actions = loadActions(file);
    const r = await replayActions(ctx, { script, actions, unsafe: a.unsafe, label: 'replay' });
    if (r.prepared?.cleanup) await r.prepared.cleanup().catch(() => {});
    const result = await r.session.close({ summary: `replayed ${r.done}/${actions.length} action(s)` }); result.runDir = r.session.dir;
    return { verdict: result.verdict, summary: formatRun(result), data: result, runDir: r.session.dir, exitCode: VERDICT_EXIT[result.verdict] ?? 1 };
  },
});

defineVerb({
  name: 'reduce', group: 'iterate', local: true,
  desc: 'Minimise a failing case (ddmin). mode=script: fewest LINES that still give a finding matching --match. mode=actions: shortest click path from a smoke action log.',
  args: {
    mode: { type: 'string', positional: 0, required: true, desc: 'script | actions' }, script: { type: 'string', positional: 1, required: true }, match: { type: 'string', desc: 'regex the finding message must match' },
    actions: { type: 'string', desc: 'smoke-actions.jsonl (mode=actions)' }, budget: { type: 'number', default: 240, desc: 'seconds' }, run: { type: 'boolean', desc: 'mode=script: use a real run instead of /Validate (finds runtime bugs)' },
  },
  async run(ctx, a) {
    const script = assertScript(path.resolve(ctx.cwd, a.script));
    if (a.mode === 'script') {
      const r = await reduceScript(ctx, { script, match: a.match, budgetMs: a.budget * 1000, validate: !a.run });
      return { ok: true, summary: `reduced ${r.original} → ${r.reduced} line(s) in ${r.trials} trial(s)${r.timedOut ? ' (budget hit)' : ''}\n  ${r.out}\n\n${truncate(r.text, 1500)}`, data: r, runDir: r.runDir };
    }
    if (a.mode === 'actions') {
      let file = path.resolve(ctx.cwd, a.actions || ''); if (!exists(file)) file = path.join(ctx.cfg.outDir, a.actions || '', 'smoke-actions.jsonl');
      const r = await reduceActions(ctx, { script, actionsFile: file, match: a.match, budgetMs: a.budget * 1000 });
      const out = path.join(ctx.cfg.outDir, `reduced-actions-${Date.now() % 1e6}.jsonl`); writeFile(out, r.actions.map((x) => JSON.stringify(x)).join('\n') + '\n');
      return { ok: true, summary: `reduced ${r.original} → ${r.reduced} action(s) in ${r.trials} trial(s)${r.timedOut ? ' (budget hit)' : ''}\n${r.actions.map((x, i) => `  ${i + 1}. ${x.kind} ${x.label || x.sel || ''}${x.arg !== undefined ? ' [' + truncate(String(x.arg), 30) + ']' : ''}`).join('\n')}\n  replay: ahkh replay ${a.script} --actions ${out}`, data: r };
    }
    throw new AhkhError('mode must be "script" or "actions"', 'BADARG');
  },
});

// ---------------------------------------------------------------------- AST verbs + trace

defineVerb({
  name: 'ast.outline', group: 'ast', local: true, desc: 'Structural outline via the AST engine: functions (params), classes, hotkeys, hotstrings, globals, includes.',
  args: { file: { type: 'string', positional: 0, required: true }, includes: { type: 'boolean', desc: 'follow #Include' } },
  async run(ctx, a) { const f = path.resolve(ctx.cwd, a.file); const o = await withAst(ctx, (c) => c.outline(f, { includes: a.includes })); return { ok: true, summary: renderOutline(o, f), data: o }; },
});
defineVerb({
  name: 'ast.check', group: 'ast', local: true, desc: 'Parse problems as the AST engine sees them (experimental parser: /Validate and the LSP are ground truth).',
  args: { paths: { type: 'array', positional: 'rest', required: true } },
  async run(ctx, a) {
    const files = expandPaths(a.paths, { cwd: ctx.cwd }); const L = []; let n = 0;
    await withAst(ctx, async (c) => { for (const f of files) { const r = await c.errors(f); for (const p of r.problems || []) { n++; L.push(`${path.basename(f)}:${p.start?.line}:${p.start?.col}  ${p.kind}  ${p.message}`); } } });
    return { verdict: n ? 'FAIL' : 'PASS', summary: `${n ? 'FAIL' : 'PASS'}  ast.check  ${files.length} file(s), ${n} problem(s)\n${L.slice(0, 60).join('\n')}`, exitCode: n ? 1 : 0, data: { problems: n } };
  },
});
defineVerb({
  name: 'ast.flow', group: 'ast', local: true, desc: 'Run an AST flow (trace, trace-lines, minify-safe, beautify, treeshake-safe, eval-analysis, ...) over a script; writes the result under the run folder.',
  args: { script: { type: 'string', positional: 0, required: true }, flow: { type: 'string', positional: 1, required: true }, out: { type: 'string' } },
  async run(ctx, a) {
    const f = assertScript(path.resolve(ctx.cwd, a.script)); const run = new Run(ctx.cfg, { label: 'flow-' + a.flow, kind: 'ast-flow' });
    const r = await withAst(ctx, (c) => c.flow(f, a.flow, { vars: { OutputDir: run.dir } }));
    const out = a.out ? path.resolve(ctx.cwd, a.out) : run.path('flow-output' + (/eval|diagram|nim/.test(a.flow) ? '.txt' : '.ahk')); writeFile(out, r.output);
    run.finish({ verdict: 'PASS', summary: `${a.flow} → ${r.output.length} chars in ${r.ms}ms` });
    return { ok: true, summary: `${a.flow}: ${r.output.length} chars in ${r.ms}ms\n  ${out}${(r.log || []).length ? '\n  log: ' + truncate(r.log.join(' | '), 300) : ''}`, data: { out, ms: r.ms, log: r.log }, runDir: run.dir };
  },
});

defineVerb({
  name: 'trace', group: 'ast', local: true,
  desc: 'Instrument a script with the AST TraceWrapper (function/event/hotkey tracing), run it for N seconds on the hidden desktop, close it gracefully and summarise the call tree (counts, time, errors).',
  args: { script: { type: 'string', positional: 0, required: true }, for: { type: 'number', default: 5 }, lines: { type: 'boolean', desc: 'trace every line (coverage) + try/catch + profiling' }, top: { type: 'number', default: 15 } },
  async run(ctx, a) {
    const script = assertScript(path.resolve(ctx.cwd, a.script)); const { exe } = resolveAhk(ctx.cfg, script);
    const s = await Session.open(ctx, { label: 'trace-' + path.basename(script, '.ahk'), kind: 'trace', keepGoing: true });
    let prepared = null; const dumpDir = ensureDir(s.run.path('trace'));
    try {
      const flow = await withAst(ctx, (c) => c.flow(script, a.lines ? 'trace-lines' : 'trace', { vars: { OutputDir: dumpDir } }));
      prepared = await prepareTarget(ctx, s, script, { overlay: 'always' });
      writeFile(prepared.entry, flow.output);
      await s.launch({ name: 'main', exe, cwd: prepared.cwd, scriptName: scriptNameOf(script), expect: 'running', args: ahkArgs({ script: prepared.entry, includes: prepared.includes }) });
      await s.waitExit('main', a.for * 1000, { soft: true });
      const p = s.proc('main');
      if (!p.exited) {   // graceful: WM_CLOSE to AHK's main window runs OnExit (the trace is written there); the kill comes only if that fails
        const w = (await s.windowsList({ all: true, proc: 'main' })).find((x) => x.class === 'AutoHotkey');
        if (w) await s.host.request('win.msg', { hwnd: w.hwnd, msg: 0x10, wparam: 0, lparam: 0, post: true });
        await s.waitExit('main', 4000, { soft: true });
      }
    } catch (e) { s.addFinding({ severity: 'error', kind: 'host-error', message: e.message }); }
    harvestAhkText(s, 'main');
    const dump = path.join(dumpDir, '__trace_dump.json'); const agg = new Map(); let total = 0;
    if (exists(dump)) {
      try {
        const tree = JSON.parse(readText(dump).replace(/^\uFEFF/, ''));
        const walk = (nodes) => { for (const n of nodes || []) { if (n.Type === 'Line') continue; total++; const k = n.Name; const e = agg.get(k) || { name: k, calls: 0, ms: 0, errors: 0 }; e.calls++; e.ms += Number(n.Elapsed) || 0; if (n.Error) e.errors++; agg.set(k, e); walk(n.Children); } };
        walk(Array.isArray(tree) ? tree : tree.Calls || tree.calls || [tree]);
      } catch (e) { s.addFinding({ severity: 'warn', kind: 'host-error', message: 'could not parse trace dump: ' + e.message }); }
    } else s.addFinding({ severity: 'warn', kind: 'trace-missing', message: 'no trace dump was written (the script must exit through OnExit; it may have been killed)' });
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
    const result = await s.close({ summary: `${total} traced call(s)` }); result.runDir = s.dir;
    const top = [...agg.values()].sort((x, y) => y.ms - x.ms || y.calls - x.calls).slice(0, a.top);
    const L = [formatRun(result), '  traced calls: ' + total, ...top.map((e) => `  ${String(e.calls).padStart(5)}×  ${String(e.ms.toFixed ? e.ms.toFixed(1) : e.ms).padStart(9)}ms  ${e.errors ? `✗${e.errors} ` : ''}${e.name}`)];
    return { verdict: result.verdict, summary: L.join('\n'), data: { top, total }, runDir: s.dir, exitCode: VERDICT_EXIT[result.verdict] ?? 1 };
  },
});
