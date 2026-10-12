// Probe + patch verbs: temporary script modification and in-process introspection/driving.
import path from 'node:path';
import fs from 'node:fs';
import { defineVerb } from './registry.mjs';
import { getSession } from './session.mjs';
import { Run } from '../evidence.mjs';
import { loadRecipes, buildOverlay } from '../overlay.mjs';
import { assertScript } from '../adapters/ahk2.mjs';
import { AhkhError, truncate, sleep } from '../util.mjs';

const T = { session: { type: 'string', alias: 's', desc: 'session id (default: most recent)' } };

defineVerb({
  name: 'patch', group: 'modify', local: true,
  desc: 'Apply patch recipes to a SHADOW COPY of a script (originals are never touched); show the diff and the effective entry path.',
  args: {
    script: { type: 'string', positional: 0, required: true },
    patch: { type: 'array', required: true, desc: 'recipe names (patches/*.json), file paths or inline JSON ops' },
    diff: { type: 'boolean', desc: 'print the unified diff' },
  },
  async run(ctx, a) {
    const script = assertScript(path.resolve(ctx.cwd, a.script));
    const { ops, names } = loadRecipes(ctx.cfg, a.patch);
    const run = new Run(ctx.cfg, { label: 'patch-' + path.basename(script, '.ahk'), kind: 'patch' });
    const built = buildOverlay({ cfg: ctx.cfg, run, script, ops, names });
    run.write('effective.diff', built.diff);
    const result = run.finish({ verdict: 'PASS', summary: `patched ${built.changed.length} file(s)`, data: { entry: built.entry, log: built.log } });
    const L = [`patched ${built.changed.length} file(s) in a shadow copy (${built.stats.files} files copied). Original untouched.`, `  effective entry: ${built.entry}`, ...built.log.map((l) => '  · ' + l)];
    if (a.diff && built.diff) L.push('', built.diff);
    L.push(`  run: ${run.dir}`);
    return { ok: true, summary: L.join('\n'), data: { entry: built.entry, linemap: built.linemap, log: built.log, diff: built.diff, run: result.run }, runDir: run.dir };
  },
});

defineVerb({
  name: 'patches', group: 'modify', local: true, desc: 'List available patch recipes.', args: {},
  async run(ctx) {
    const dirs = [path.join(ctx.cfg.harnessRoot, 'patches'), path.join(ctx.cfg.root, 'patches')];
    const seen = new Map();
    for (const d of dirs) { try { for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) { const r = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); seen.set(r.name || f, r.desc || ''); } } catch { /* none */ } }
    return { ok: true, summary: [...seen].map(([n, d]) => `${n.padEnd(16)} ${d}`).join('\n') || '(none)', data: Object.fromEntries(seen) };
  },
});

function probeOf(s) {
  if (!s.probe) throw new AhkhError('this session has no probe. Start it with: ahkh session.start <script> --probe', 'NOPROBE');
  return s.probe;
}

defineVerb({
  name: 'probe', group: 'probe', needsHub: true,
  desc: 'Send a raw command to the in-process AhkProbe: ping | guis | menus | hotkeys | fire | call | get | set | log | exit | shot (composed screenshot taken from inside the script) | unexclude | reexclude.',
  args: { ...T, cmd: { type: 'string', positional: 0, required: true }, args: { type: 'json', positional: 1, desc: 'JSON object of arguments' }, timeout: { type: 'number', default: 6 } },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    const r = await probeOf(s).call(a.cmd, a.args || {}, a.timeout * 1000);
    return { ok: true, summary: truncate(JSON.stringify(r, null, 1), 4000), data: r };
  },
});

defineVerb({
  name: 'guis', group: 'probe', needsHub: true,
  desc: 'AHK-level view from the probe: every Gui + control the script created, with names, types, values and the events wired to them.',
  args: { ...T },
  async run(ctx, a) {
    const s = getSession(ctx, a); const gs = await probeOf(s).call('guis');
    const L = [];
    for (const g of gs) {
      L.push(`${g.id}  hwnd=0x${Number(g.hwnd).toString(16).toUpperCase()}  "${g.title}"${g.visible ? '' : '  hidden'}  events: ${(g.events || []).map((e) => `${e.event}(${e.handlers})`).join(' ') || '-'}`);
      for (const c of g.controls) L.push(`   ${c.id.padEnd(4)} ${String(c.type || c.kind).padEnd(12)} ${c.name ? 'name=' + c.name + ' ' : ''}${c.text !== undefined && c.text !== '' ? `text="${truncate(String(c.text), 30)}" ` : ''}${c.value !== undefined && c.value !== '' && c.value !== c.text ? `value=${JSON.stringify(c.value)} ` : ''}${c.enabled === 0 ? 'disabled ' : ''}events: ${(c.events || []).map((e) => `${e.event}(${e.handlers})`).join(' ') || '-'}`);
    }
    return { ok: true, summary: L.join('\n') || '(no GUIs registered)', data: gs };
  },
});

defineVerb({
  name: 'fire', group: 'probe', needsHub: true,
  desc: 'Invoke a control/GUI event handler INSIDE the script (errors come back structured, no dialog): e.g. fire --ctrl c3 --event Click.',
  args: { ...T, ctrl: { type: 'string' }, gui: { type: 'string' }, event: { type: 'string', default: 'Click' }, info: { type: 'string' } },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    const r = await probeOf(s).call('fire', { ctrl: a.ctrl, gui: a.gui, event: a.event, info: a.info ?? 0 });
    const errs = r.errors || [];
    for (const e of errs) s.addFinding({ severity: 'error', kind: 'runtime-error', message: `${e.message} (in ${a.event} handler)`, file: e.file, line: e.line });
    return { ok: !errs.length, summary: `called ${r.called} handler(s)${r.note ? ' — ' + r.note : ''}${errs.map((e) => `\n  ✗ ${e.message} [${path.basename(e.file || '')}:${e.line}]`).join('')}`, data: r };
  },
});

defineVerb({
  name: 'call', group: 'probe', needsHub: true, desc: 'Call a global function of the script by name with JSON args; returns result or structured error.',
  args: { ...T, fn: { type: 'string', positional: 0, required: true, desc: 'function name, or Class.Method / obj.prop.Method' }, args: { type: 'json', positional: 1 }, timeout: { type: 'number', default: 6, desc: 'seconds' } },
  async run(ctx, a) {
    const s = getSession(ctx, a); const r = await probeOf(s).call('call', { fn: a.fn, args: a.args || [] }, a.timeout * 1000);
    if (!r.ok) s.addFinding({ severity: 'error', kind: 'runtime-error', message: `${r.error?.message} (calling ${a.fn})`, file: r.error?.file, line: r.error?.line });
    return { ok: !!r.ok, summary: r.ok ? `${a.fn}() → ${JSON.stringify(r.result)}` : `✗ ${r.error?.message} [${path.basename(r.error?.file || '')}:${r.error?.line}]`, data: r };
  },
});

defineVerb({
  name: 'var', group: 'probe', needsHub: true, desc: 'Read (or with --value, write) a global variable of the script.',
  args: { ...T, name: { type: 'string', positional: 0, required: true }, value: { type: 'json', positional: 1 } },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    if (a.value !== undefined) { await probeOf(s).call('set', { name: a.name, value: a.value }); return { ok: true, summary: `${a.name} set` }; }
    const r = await probeOf(s).call('get', { name: a.name });
    return { ok: true, summary: `${a.name} = ${truncate(JSON.stringify(r), 500)}`, data: r };
  },
});

// ---------------------------------------------------------------------- hotkeys (WM_HOTKEY to AHK's hidden main window; no keyboard input involved)

async function mainAhkWindow(s, procName) {
  const all = await s.windowsList({ all: true, proc: procName });
  const w = all.find((x) => x.class === 'AutoHotkey');
  if (!w) throw new AhkhError('could not find AutoHotkey\'s main window in the session (is the script running?)', 'NOWIN');
  return w;
}

defineVerb({
  name: 'hotkey.list', group: 'probe', needsHub: true, desc: 'List the script\'s hotkeys (via ListHotkeys through the probe).', args: { ...T },
  async run(ctx, a) {
    const s = getSession(ctx, a); const txt = await probeOf(s).call('hotkeys');
    const lines = String(txt).split(/\r?\n/).filter(Boolean);
    return { ok: true, summary: lines.join('\n') || '(no hotkeys)', data: lines };
  },
});

defineVerb({
  name: 'hotkey.fire', group: 'input', needsHub: true,
  desc: 'Trigger hotkey number N (or every one with --all) by posting WM_HOTKEY to the script; nothing is typed, nothing reaches your keyboard.',
  args: { ...T, id: { type: 'number', positional: 0 }, all: { type: 'number', desc: 'fire ids 0..N-1' }, proc: { type: 'string' }, delay: { type: 'number', default: 150 } },
  async run(ctx, a) {
    const s = getSession(ctx, a); const w = await mainAhkWindow(s, a.proc);
    const ids = a.all ? Array.from({ length: a.all }, (_, i) => i) : [a.id ?? 0];
    for (const id of ids) { await s.host.request('win.msg', { hwnd: w.hwnd, msg: 0x312, wparam: id, lparam: 0, post: true }); s.run.event('act.hotkey', { id }); await sleep(a.delay); }
    return { ok: true, summary: `fired hotkey id(s) ${ids.join(',')}` };
  },
});
