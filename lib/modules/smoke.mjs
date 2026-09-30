// Automatic smoke tester: point it at an unknown AHK v2 GUI script; it discovers the surface (controls, menus, hotkeys, timers),
// pokes everything (never the dangerous-looking things), watches for errors/dialogs/hangs/crashes/leaks, and leaves an evidence bundle
// with a replayable action log. Everything happens on the hidden desktop, on a shadow copy of the script folder.
import path from 'node:path';
import fs from 'node:fs';
import { Session } from '../session.mjs';
import { prepareTarget, codeMasks } from '../overlay.mjs';
import { resolveAhk, ahkArgs, assertScript, harvestAhkText, scriptNameOf } from '../adapters/ahk2.mjs';
import { buildIncludeGraph } from './includes.mjs';
import { LspClient } from '../lsp/client.mjs';
import { findAhk } from '../config.mjs';
import { formatRun } from '../verbs/run.mjs';
import { VERDICT_EXIT } from '../evidence.mjs';
import { sleep, sha1, readText, truncate, fmtMs, writeJson, AhkhError } from '../util.mjs';

export const DEFAULT_DENY = 'delete|remove|erase|wipe|format|uninstall|destroy|purge|reset|shut ?down|restart|reboot|log ?out|sign ?out|send|submit|pay|purchase|buy|overwrite|clear all|kill';
const FUZZ = ['', 'a', 'Hello World', '0', '-1', '99999999999999999999', 'x'.repeat(300), 'Ünïcödé ✓ 日本語', '\'"`%;{}[]()', 'C:\\Windows\\System32\\', '%A_ScriptDir%', '1e999', 'line1\nline2', '   ', 'NaN', '<script>alert(1)</script>'];
const DANGEROUS_CALLS = ['FileDelete', 'FileRecycle', 'DirDelete', 'DirMove', 'FileMove', 'RegDelete', 'RegDeleteKey', 'RegWrite', 'Run', 'RunWait', 'RunAs', 'ProcessClose', 'WinKill', 'Shutdown', 'DllCall', 'ComObject', 'URLDownloadToFile', 'Download'];

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffle = (arr, r) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------------------------------------------------------------------- S0: static

export function staticScan(files) {
  const out = { dangerous: [], timers: [], onMessage: [], hotkeys: 0, guis: 0, lines: 0 };
  for (const f of files) {
    let text; try { text = readText(f); } catch { continue; }
    const lines = text.split(/\r?\n/); out.lines += lines.length;
    const masks = codeMasks(lines);
    lines.forEach((line, i) => {
      const code = [...line].map((ch, k) => (masks[i][k] ? ch : ' ')).join('');
      for (const name of DANGEROUS_CALLS) if (new RegExp(`(?<![\\w.])${name}\\s*[(\\s]`).test(code) && !/^\s*(class|static)\b/.test(code)) out.dangerous.push({ file: f, line: i + 1, call: name });
      let m;
      if ((m = /(?<![\w.])SetTimer\s*\(?\s*([A-Za-z_][\w.]*)?/.exec(code)) && m[1] && !/^(Off|On)$/i.test(m[1])) out.timers.push({ file: f, line: i + 1, fn: m[1] });
      if ((m = /(?<![\w.])OnMessage\s*\(\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*([A-Za-z_][\w.]*)?/.exec(code))) out.onMessage.push({ file: f, line: i + 1, msg: m[1], fn: m[2] });
      if (/^\s*[~*$!+^#<>]*[\w]+(\s+&\s+[\w]+)?(\s+up)?::/.test(code) && !/^\s*\w+:\s*$/.test(code)) out.hotkeys++;
      if (/(?<![\w.])Gui\s*\(/.test(code)) out.guis++;
    });
  }
  return out;
}

// ---------------------------------------------------------------------- surface capture

const SKIP_KINDS = new Set(['tooltip', 'ahk-main']);
const ACTIONABLE = new Set(['button', 'checkbox', 'radio', 'combo', 'list', 'edit', 'tab', 'slider', 'link', 'listview', 'treeview', 'updown', 'datetime', 'calendar']);

async function captureSurface(s, probeGuis) {
  // Only application windows: transient dialogs (msgbox, AHK error/warning, input/file dialogs) are handled by the rules, never poked.
  const wins = (await s.windowsList({})).filter((w) => (w.kind === 'ahk-gui' || w.kind === 'window') && !SKIP_KINDS.has(w.kind));
  const controls = [];
  const probeByHwnd = new Map();
  for (const g of probeGuis || []) for (const c of g.controls || []) if (c.hwnd) probeByHwnd.set('0x' + Number(c.hwnd).toString(16).toUpperCase(), { ...c, gui: g.id });
  for (const w of wins) {
    let tree; try { tree = await s.tree({ hwnd: w.hwnd }); } catch { continue; }
    tree.controls.forEach((c, i) => {
      const p = probeByHwnd.get(c.hwnd);
      controls.push({ ...c, win: w.hwnd, winRef: w.ref, winTitle: w.title, winKind: w.kind, ref: c.ref, probe: p || null, order: i });
    });
  }
  const sig = sha1(JSON.stringify([wins.map((w) => `${w.class}|${w.title}|${w.kind}|${w.minimized ? 'm' : ''}`).sort(), controls.filter((c) => c.visible).map((c) => `${c.kind}|${c.class}|${c.kind === 'edit' ? '' : c.text}|${c.enabled}`).sort()])).slice(0, 10);
  return { wins, controls, sig };
}

function selectorFor(c, all) {
  const same = all.filter((x) => x.win === c.win && x.kind === c.kind && (x.text || '') === (c.text || '') && x.class === c.class);
  const idx = same.indexOf(c);
  const t = (c.text || '').replace(/&/g, '');
  return `kind=${c.kind}&class=${c.class}${t ? '&text=' + t.replace(/&/g, '') : ''}${same.length > 1 ? '&index=' + idx : ''}`;
}

// ---------------------------------------------------------------------- the run

export async function runSmoke(ctx, o) {
  const script = assertScript(path.resolve(ctx.cwd, o.script));
  const { exe } = resolveAhk(ctx.cfg, script);
  const r = rng(o.seed);
  const deny = new RegExp(o.deny || DEFAULT_DENY, 'i');
  const allow = o.allow ? new RegExp(o.allow, 'i') : null;
  const t0 = Date.now(); const budgetMs = o.budget * 1000;
  const timeLeft = () => budgetMs - (Date.now() - t0);

  const s = await Session.open(ctx, {
    label: o.label || 'smoke-' + path.basename(script, '.ahk'), kind: 'smoke', keepGoing: o.keepGoing,
    rules: [{ name: 'msgbox-safe', match: { kind: 'msgbox' }, do: { shot: true, press: 'safe', verdict: 'dialog' } }],
    shots: { onDialog: true, onWindow: false, maxEdge: 1100 }, meta: { script, ahk: exe, seed: o.seed, budget: o.budget },
  });
  const report = { phases: {}, actions: [], skipped: [], coverage: {}, graph: { nodes: {}, edges: [] } };
  const say = (msg) => s.run.event('smoke', { msg });
  let prepared = null;
  try {
    // ---------------- S0 static
    const includeGraph = buildIncludeGraph(script, { ahkExe: findAhk(ctx.cfg) });
    const files = includeGraph.files;
    for (const m of includeGraph.missing) s.addFinding({ severity: 'warn', kind: 'include-missing', message: `#Include not found: ${m.spec}`, file: m.from, line: m.line });
    const scan = staticScan(files);
    report.static = { files: files.length, lines: scan.lines, hotkeys: scan.hotkeys, guis: scan.guis, timers: scan.timers, onMessage: scan.onMessage.length, dangerous: scan.dangerous.length };
    if (scan.dangerous.length) s.addFinding({ severity: 'info', kind: 'danger-scan', message: `${scan.dangerous.length} call(s) to destructive/system APIs: ${[...new Set(scan.dangerous.map((d) => d.call))].join(', ')} — ${o.unsafe ? 'running UNSAFE (no stubs)' : 'stubbed for this run'}` });
    if (o.lsp !== false) {
      try {
        const lsp = new LspClient(ctx.cfg); await lsp.start({ rootDir: path.dirname(script) });
        try { for (const f of files.slice(0, 40)) { const d = await lsp.diagnostics(f, { settleMs: 700 }); for (const x of d.diagnostics.filter((y) => y.severity === 'error' || y.severity === 'warning')) s.addFinding({ severity: x.severity === 'error' ? 'error' : 'warn', kind: 'lsp-' + x.severity, message: x.message, file: x.file, line: x.line }); } }
        finally { await lsp.stop(); }
      } catch (e) { say('LSP skipped: ' + e.message); }
    }
    report.phases.S0 = { ms: Date.now() - t0 };
    if (o.level === 'static') return await finish(ctx, s, report, prepared);

    // ---------------- S1 boot
    const patch = [...(o.patch || [])]; if (!o.unsafe && !patch.includes('stub-dangerous')) patch.push('stub-dangerous');
    prepared = await prepareTarget(ctx, s, script, { patch, probe: 'rpc', overlay: o.inPlace ? 'never' : 'always', onError: 'log' });
    await s.launch({ name: 'main', exe, cwd: prepared.cwd, scriptName: scriptNameOf(script), expect: 'running', args: ahkArgs({ script: prepared.entry, scriptArgs: o.args || [], includes: prepared.includes }), env: prepared.env });
    const p = s.proc('main');
    const bootEnd = Date.now() + Math.min(9000, Math.max(3000, timeLeft() / 4));
    while (Date.now() < bootEnd && !p.exited && ![...s.windows.values()].some((w) => w.alive && w.visible && w.ready && !SKIP_KINDS.has(w.kind))) await sleep(60);
    await sleep(300);
    report.phases.S1 = { ms: Date.now() - t0, windows: [...s.windows.values()].filter((w) => w.alive && w.visible).length, exited: p.exited };
    if (p.exited) { say(`script exited during boot (code ${p.exitCode})`); harvestAhkText(s, 'main', { linemap: prepared.linemap }); return await finish(ctx, s, report, prepared); }
    try { await s.shot({ desktop: true, label: 'first-paint', maxEdge: 1100 }); } catch { /* no window */ }
    if (o.level === 'boot') return await finish(ctx, s, report, prepared);

    // ---------------- S2 discover
    let guis = [], menus = [], hotkeyLines = [];
    try { guis = await s.probe.call('guis'); } catch (e) { say('probe guis: ' + e.message); }
    try { menus = await s.probe.call('menus'); } catch { /* none */ }
    try { const txt = await s.probe.call('hotkeys'); hotkeyLines = String(txt).split(/\r?\n/).filter((l) => l && !/^Type\s/.test(l) && !/^-+$/.test(l)); } catch { /* none */ }
    let surface = await captureSurface(s, guis);
    const nodeOf = (sig) => (report.graph.nodes[sig] ||= { id: 'S' + Object.keys(report.graph.nodes).length, windows: surface.wins.map((w) => w.title), controls: surface.controls.length, visits: 0 });
    nodeOf(surface.sig).visits++;
    report.surface = { windows: surface.wins.map((w) => ({ hwnd: w.hwnd, title: w.title, class: w.class, kind: w.kind })), controls: surface.controls.filter((c) => ACTIONABLE.has(c.kind)).length, hotkeys: hotkeyLines.length, menus: menus.reduce((n, m) => n + m.items.length, 0), timers: scan.timers.length, probeGuis: guis.length };
    writeJson(s.run.path('smoke-surface.json'), { ...report.surface, hotkeyLines, menus, controls: surface.controls.map((c) => ({ kind: c.kind, text: c.text, class: c.class, win: c.winTitle, events: c.probe?.events })) });
    s.run.artifact('surface', s.run.path('smoke-surface.json'));
    report.phases.S2 = { ms: Date.now() - t0 };
    say(`surface: ${report.surface.controls} actionable control(s), ${hotkeyLines.length} hotkey(s), ${report.surface.menus} menu item(s), ${scan.timers.length} timer(s)`);
    if (o.level === 'discover') return await finish(ctx, s, report, prepared);

    // ---------------- S3-S5 poke / observe / rip
    const cov = { controls: new Set(), controlsSeen: new Set(), hotkeys: 0, menus: 0, timers: 0, dialogs: 0, windowsSeen: new Set() };
    const metricsAt = []; let actionN = 0; let lastShotSig = surface.sig;
    const queue = buildQueue(surface, hotkeyLines, menus, scan, o, r, deny, allow, report, cov);
    say(`queued ${queue.length} action(s)`);
    for (const c of surface.controls) if (ACTIONABLE.has(c.kind)) cov.controlsSeen.add(selectorFor(c, surface.controls));

    const baseMetrics = await s.metrics('main').catch(() => null); if (baseMetrics) metricsAt.push({ n: 0, m: baseMetrics });
    while (queue.length && actionN < o.maxActions && timeLeft() > 2500 && !p.exited) {
      const act = queue.shift();
      actionN++;
      const before = { f: s.run.findings.length, d: s.dialogs.length, out: p.out.length, err: p.err.length, wins: new Set([...s.windows.values()].filter((w) => w.alive && w.visible).map((w) => w.hwnd)), sig: surface.sig };
      const ts = Date.now(); let result = null; let error = null;
      try { result = await perform(s, act, surface); } catch (e) { error = e.message; }
      await s.waitIdle({ quietMs: 140, timeout: 1600 }).catch(() => {});
      const hungNow = [...s.procs.values()].some((x) => x.hung);
      // re-capture (cheap) so the graph and queue follow the app as it changes
      let after = surface;
      if (!p.exited) { try { after = await captureSurface(s, guis); } catch { /* window gone */ } }
      const newFindings = s.run.findings.slice(before.f).filter((f) => f.severity === 'error' || f.severity === 'warn');
      for (const f of s.run.findings.slice(before.f)) f.action = actionN;
      const newDialogs = s.dialogs.slice(before.d);
      const newWins = [...s.windows.values()].filter((w) => w.alive && w.visible && !before.wins.has(w.hwnd) && !SKIP_KINDS.has(w.kind));
      const outDelta = p.out.slice(before.out).filter((l) => !l.startsWith('AHKH|')).concat(p.err.slice(before.err));
      const changed = after.sig !== before.sig;
      let shot = null;
      if ((newFindings.some((f) => f.severity === 'error') || newDialogs.length || newWins.length || (changed && after.sig !== lastShotSig)) && timeLeft() > 2000) {
        try { const sh = await s.shot({ desktop: true, label: `a${actionN}-${act.kind}`, maxEdge: 1100 }); shot = sh.path; lastShotSig = after.sig; } catch { /* ignore */ }
      }
      const row = { n: actionN, kind: act.kind, sel: act.sel, label: act.label, arg: act.arg, ms: Date.now() - ts, error, result: result && typeof result === 'object' ? truncate(JSON.stringify(result), 160) : result, findings: newFindings.length, dialogs: newDialogs.map((d) => `${d.kind}:${truncate(d.text || d.title, 40)}`), newWindows: newWins.map((w) => w.title), stdout: outDelta.slice(0, 6), stateChanged: changed, hung: hungNow, shot };
      report.actions.push(row);
      s.run.event('smoke.action', row);
      if (act.covKey) cov.controls.add(act.covKey);
      if (act.kind === 'hotkey') cov.hotkeys++; if (act.kind === 'menu') cov.menus++; if (act.kind === 'timer') cov.timers++;
      cov.dialogs += newDialogs.length;
      // state graph
      surface = after;
      const to = nodeOf(after.sig); to.visits++;
      report.graph.edges.push({ from: before.sig, to: after.sig, action: `${act.kind}:${act.label || act.sel || ''}` });
      // new controls appeared (tab switched, window opened): queue them (rip)
      if (changed && after.controls.length) {
        const fresh = after.controls.filter((c) => ACTIONABLE.has(c.kind) && c.visible && !cov.controlsSeen.has(selectorFor(c, after.controls)));
        if (fresh.length) { for (const c of fresh) cov.controlsSeen.add(selectorFor(c, after.controls)); queue.unshift(...buildQueue({ ...after, controls: fresh }, [], [], { timers: [] }, o, r, deny, allow, report, cov)); say(`new UI state: queued ${fresh.length} newly visible control(s)`); }
      }
      if (actionN % 12 === 0) { const m = await s.metrics('main').catch(() => null); if (m) metricsAt.push({ n: actionN, m }); }
    }
    // closing the window (WM_SYSCOMMAND SC_CLOSE) exercises Close handlers, and reveals "won't close" bugs
    if (!p.exited && o.closeAtEnd !== false) {
      try { await s.winAction('close', { proc: 'main' }); await s.waitExit('main', 2500, { soft: true }); report.closed = p.exited ? 'window close ended the process' : 'process still running after window close (may be tray-resident)'; } catch { /* no window */ }
    }
    report.phases.S3 = { ms: Date.now() - t0, actions: actionN };
    const last = metricsAt[metricsAt.length - 1]; const first = metricsAt[0];
    if (first && last && first !== last) {
      const sum = (m, k) => m.m.processes.reduce((a, x) => a + (x[k] || 0), 0);
      report.metrics = { startHandles: sum(first, 'handles'), endHandles: sum(last, 'handles'), startGdi: sum(first, 'gdi'), endGdi: sum(last, 'gdi'), startWorkingSetMB: +sum(first, 'workingSetMB').toFixed(1), endWorkingSetMB: +sum(last, 'workingSetMB').toFixed(1) };
      if (report.metrics.endGdi - report.metrics.startGdi > 100) s.addFinding({ severity: 'warn', kind: 'gdi-leak', message: `GDI objects grew ${report.metrics.startGdi} → ${report.metrics.endGdi} over ${actionN} actions` });
      if (report.metrics.endHandles - report.metrics.startHandles > 300) s.addFinding({ severity: 'warn', kind: 'handle-leak', message: `handles grew ${report.metrics.startHandles} → ${report.metrics.endHandles} over ${actionN} actions` });
    }
    report.coverage = { controlsPoked: cov.controls.size, controlsTotal: cov.controlsSeen.size, hotkeysFired: cov.hotkeys, hotkeysTotal: hotkeyLines.length, menuItemsFired: cov.menus, timersCalled: cov.timers, dialogsSeen: cov.dialogs };
    report.unpoked = [...cov.controlsSeen].filter((x) => !cov.controls.has(x)).slice(0, 30);
    return await finish(ctx, s, report, prepared);
  } catch (e) {
    s.addFinding({ severity: 'error', kind: 'host-error', message: 'smoke aborted: ' + e.message });
    return await finish(ctx, s, report, prepared);
  }
}

async function finish(ctx, s, report, prepared) {
  writeJson(s.run.path('smoke-report.json'), { ...report, actions: undefined, graph: report.graph });
  s.run.artifact('smoke', s.run.path('smoke-report.json'));
  const lines = report.actions.map((a) => JSON.stringify({ n: a.n, kind: a.kind, sel: a.sel, label: a.label, arg: a.arg })).join('\n');
  if (lines) { s.run.write('smoke-actions.jsonl', lines + '\n'); s.run.artifact('replay', s.run.path('smoke-actions.jsonl')); }
  if (prepared?.cleanup) { try { await prepared.cleanup(); } catch { /* ignore */ } }
  const c = report.coverage || {};
  const errs = s.run.findings.filter((f) => f.severity === 'error');
  const summary = `${report.actions.length} action(s)` + (c.controlsTotal !== undefined ? ` · controls ${c.controlsPoked}/${c.controlsTotal} · hotkeys ${c.hotkeysFired}/${c.hotkeysTotal}` : '') + ` · ${s.dialogs.length} dialog(s) · ${errs.length} error(s)`;
  const result = await s.close({ summary, finalShot: true });
  result.runDir = s.dir;
  const L = [formatRun(result, { max: 12 })];
  if (report.static) L.push(`  static: ${report.static.files} file(s), ${report.static.lines} lines, ${report.static.hotkeys} hotkey(s), ${report.static.timers.length} timer(s), ${report.static.dangerous} dangerous call(s)`);
  if (report.surface) L.push(`  surface: ${report.surface.controls} control(s), ${report.surface.hotkeys} hotkey(s), ${report.surface.menus} menu item(s)`);
  if (report.closed) L.push(`  close: ${report.closed}`);
  if (report.skipped.length) L.push(`  skipped (dangerous-looking): ${report.skipped.slice(0, 6).map((x) => x.label).join(', ')}${report.skipped.length > 6 ? '…' : ''}`);
  if (report.metrics) L.push(`  handles ${report.metrics.startHandles}→${report.metrics.endHandles} · gdi ${report.metrics.startGdi}→${report.metrics.endGdi} · ws ${report.metrics.startWorkingSetMB}→${report.metrics.endWorkingSetMB}MB`);
  const bad = report.actions.filter((a) => a.findings || a.error || a.hung).slice(0, 8);
  for (const a of bad) L.push(`  action #${a.n} ${a.kind} ${a.label || a.sel || ''}${a.arg !== undefined ? ' [' + truncate(String(a.arg), 30) + ']' : ''} → ${a.findings} finding(s)${a.error ? ', ' + a.error : ''}${a.hung ? ', HUNG' : ''}`);
  return { verdict: result.verdict, summary: L.join('\n'), data: { report: { ...report, actions: report.actions.length }, result }, runDir: s.dir, exitCode: VERDICT_EXIT[result.verdict] ?? 1 };
}

// ---------------------------------------------------------------------- action queue

function buildQueue(surface, hotkeyLines, menus, scan, o, r, deny, allow, report, cov) {
  const acts = [];
  const mine = surface.controls.filter((c) => c.visible && c.enabled && ACTIONABLE.has(c.kind));
  for (const c of mine) {
    const label = (c.text || '').replace(/&/g, '');
    const sel = selectorFor(c, surface.controls);
    const dangerous = deny.test(label) && !(allow && allow.test(label));
    if (dangerous) { report.skipped.push({ label: `${c.kind} "${label}"`, reason: 'deny-list' }); continue; }
    const base = { sel, label: `${c.kind} "${truncate(label, 24)}"`, covKey: sel, hwnd: c.hwnd, ckind: c.kind };
    switch (c.kind) {
      case 'button': case 'link': acts.push({ ...base, kind: 'press' }); break;
      case 'checkbox': case 'radio': acts.push({ ...base, kind: 'check' }, { ...base, kind: 'check' }); break;
      case 'combo': case 'list': for (let i = 0; i < Math.min(c.count || 0, 6); i++) acts.push({ ...base, kind: 'select', arg: i }); break;
      case 'edit': for (const f of shuffle(FUZZ, r).slice(0, o.fuzz)) acts.push({ ...base, kind: 'text', arg: f }); break;
      case 'tab': for (let i = 0; i < Math.max(2, Math.min(c.count || 2, 6)); i++) acts.push({ ...base, kind: 'key', arg: 'Right' }); break;
      case 'slider': case 'updown': for (const k of ['Right', 'Left', 'Home', 'End', 'Up', 'Down']) acts.push({ ...base, kind: 'key', arg: k }); break;
      case 'listview': case 'treeview': for (const k of ['Down', 'Down', 'Up', 'Enter', 'Space']) acts.push({ ...base, kind: 'key', arg: k }); break;
      default: acts.push({ ...base, kind: 'click' });
    }
  }
  const ordered = shuffle(acts, r);
  for (const w of surface.wins.filter((x) => x.kind === 'ahk-gui').slice(0, 2)) {
    for (const [i, a] of [['maximize'], ['restore'], ['move', { w: 420, h: 300 }], ['move', { w: 900, h: 700 }], ['minimize'], ['restore']].entries()) ordered.push({ kind: 'window', label: `window ${a[0]}`, arg: a[0] + (a[1] ? JSON.stringify(a[1]) : ''), hwnd: w.hwnd, act: a[0], extra: a[1] || {}, sel: `window:${w.title}` });
  }
  if (!o.noHotkeys) for (let id = 0; id < hotkeyLines.length; id++) ordered.push({ kind: 'hotkey', label: `hotkey #${id} ${truncate(hotkeyLines[id].split('\t').pop().trim(), 20)}`, arg: id, sel: `hotkey:${id}` });
  menus.forEach((m, mi) => m.items.forEach((it, ii) => {
    const label = String(it.name || '').replace(/&/g, '');
    if (!it.callback && !it.name) return;
    if (deny.test(label) && !(allow && allow.test(label))) { report.skipped.push({ label: `menu "${label}"` }); return; }
    ordered.push({ kind: 'menu', label: `menu "${label}"`, arg: `${mi}:${ii}`, sel: `menu:${mi}:${ii}` });
  }));
  for (const t of (scan.timers || []).slice(0, 6)) if (t.fn && !/[.]/.test(t.fn)) ordered.push({ kind: 'timer', label: `timer ${t.fn}`, arg: t.fn, sel: `timer:${t.fn}` });
  return ordered;
}

// ---------------------------------------------------------------------- perform one action

export async function perform(s, act, surface) {
  const target = act.hwnd ? { hwnd: act.hwnd } : null;
  const reresolve = async () => { if (target && surface) return target; if (act.sel && !act.sel.startsWith('hotkey') && !act.sel.startsWith('menu:') && !act.sel.startsWith('timer') && !act.sel.startsWith('window:')) { const hits = await s.find(act.sel); if (!hits.length) throw new AhkhError(`control gone: ${act.sel}`, 'GONE'); return { hwnd: hits[0].hwnd }; } return target; };
  switch (act.kind) {
    case 'press': return s.press(await reresolve());
    case 'check': return s.check(await reresolve(), 'toggle');
    case 'select': return s.select(await reresolve(), { index: act.arg });
    case 'text': return s.setText(await reresolve(), String(act.arg));
    case 'key': return s.key(await reresolve(), act.arg);
    case 'click': return s.click(await reresolve(), {});
    case 'window': { const t = act.hwnd ? { hwnd: act.hwnd } : { proc: 'main' }; return s.winAction(act.act || String(act.arg).replace(/[{].*/, ''), t, act.extra || (String(act.arg).includes('{') ? JSON.parse(String(act.arg).slice(String(act.arg).indexOf('{'))) : {})); }
    case 'hotkey': {
      const all = await s.windowsList({ all: true, proc: 'main' }); const w = all.find((x) => x.class === 'AutoHotkey');
      if (!w) throw new AhkhError('no AHK main window', 'NOWIN');
      return s.host.request('win.msg', { hwnd: w.hwnd, msg: 0x312, wparam: Number(act.arg), lparam: 0, post: true });
    }
    case 'menu': { const [m, i] = String(act.arg).split(':').map(Number); const r = await s.probe.call('menufire', { menu: m, item: i }); for (const e of r.errors || []) s.addFinding({ severity: 'error', kind: 'runtime-error', message: `${e.message} (menu handler)`, file: e.file, line: e.line }); return r; }
    case 'timer': { const r = await s.probe.call('call', { fn: act.arg, args: [] }); if (!r.ok && !/too few|parameter/i.test(r.error?.message || '')) s.addFinding({ severity: 'error', kind: 'runtime-error', message: `${r.error?.message} (timer callback ${act.arg})`, file: r.error?.file, line: r.error?.line }); return r; }
    default: throw new AhkhError(`unknown action kind ${act.kind}`, 'BADACT');
  }
}
