// Interactive verbs: keep a hidden-desktop session open and drive it step by step (CLI via the hub, or MCP in-process).
import path from 'node:path';
import fs from 'node:fs';
import { defineVerb } from './registry.mjs';
import { Session } from '../session.mjs';
import { resolveAhk, ahkArgs, assertScript, harvestAhkText, harvestProbeErrors, scriptNameOf } from '../adapters/ahk2.mjs';
import { prepareTarget } from '../overlay.mjs';
import { formatRun } from './run.mjs';
import { VERDICT_EXIT } from '../evidence.mjs';
import { AhkhError, truncate, sleep, fmtMs, readText } from '../util.mjs';

export function getSession(ctx, a) {
  const id = a.session || ctx.state.current;
  const s = id && ctx.sessions.get(id);
  if (!s) throw new AhkhError(id ? `no such session: ${id}` : 'no open session. Start one: ahkh session.start --script <file.ahk>', 'NOSESSION');
  return s;
}

const T = { session: { type: 'string', alias: 's', desc: 'session id (default: the most recent)' } };
const TARGET = { type: 'string', desc: 'window/control: ref (w1, w1.4), 0xHWND, selector (button:OK, class=Edit, text~=Save), proc:NAME. Default: the main window' };

// ---------------------------------------------------------------------- renderers

const rc = (r) => (r ? `${r[0]},${r[1]} ${r[2] - r[0]}x${r[3] - r[1]}` : '');   // [l,t,r,b] screen rect (windows)
const rcw = (r) => (r ? `${r[0]},${r[1]} ${r[2]}x${r[3]}` : '');                 // [x,y,w,h] relative rect (controls)
export function renderWindows(list) {
  if (!list.length) return '(no windows)';
  return list.map((w) => `${(w.ref || '').padEnd(4)} ${w.hwnd}  ${(w.kind || 'window').padEnd(11)} "${truncate(w.title, 60)}"  [${w.class}]  ${rc(w.rect)}${w.visible ? '' : ' hidden'}${w.minimized ? ' min' : ''}${w.responsive === false ? ' NOT-RESPONDING' : ''}`).join('\n');
}

export function renderTree(t, { all = false } = {}) {
  const L = [`${t.ref} ${t.hwnd} "${truncate(t.title, 70)}" [${t.class}] ${rc(t.rect)} ${t.responsive === false ? 'NOT-RESPONDING ' : ''}dpi=${t.dpi || '?'}`];
  const kids = new Map();
  for (const c of t.controls) { if (!all && !c.visible) continue; const k = c.parent; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(c); }
  const walk = (parent, depth) => {
    for (const c of kids.get(parent) || []) {
      const st = [];
      if (c.checked) st.push(c.checked);
      if (c.selectedText !== undefined) st.push(`sel="${c.selectedText}"`); else if (c.selected !== undefined && c.selected >= 0) st.push(`sel=${c.selected}`);
      if (c.count !== undefined) st.push(`n=${c.count}`);
      if (!c.enabled) st.push('disabled');
      if (!c.visible) st.push('hidden');
      L.push(`${'  '.repeat(depth)}${c.ref.padEnd(7)} ${c.kind.padEnd(9)} ${c.text ? `"${truncate(c.text.replace(/\r?\n/g, '\\n'), 50)}"` : ''} [${c.class}] id=${c.id} ${c.rect[0]},${c.rect[1]} ${c.rect[2]}x${c.rect[3]}${st.length ? '  ' + st.join(' ') : ''}`.trimEnd());
      walk(c.hwnd, depth + 1);
    }
  };
  walk(t.hwnd, 1);
  return L.join('\n');
}

function statusText(s) {
  const procs = [...s.procs.values()].map((p) => `${p.name}(pid ${p.pid}) ${p.exited ? `exited ${p.exitCode}${p.killedBy ? ' [' + p.killedBy + ']' : ''}` : 'running'}`).join(', ');
  const wins = [...s.windows.values()].filter((w) => w.alive && w.visible);
  const errs = s.run.findings.filter((f) => f.severity === 'error').length;
  return `session ${s.id} · ${procs || 'no processes'} · ${wins.length} window(s) · ${s.dialogs.length} dialog(s) · ${errs} error finding(s) · ${s.shots.length} shot(s)\n  run: ${s.dir}`;
}

// ---------------------------------------------------------------------- lifecycle

defineVerb({
  name: 'session.start', group: 'session', needsHub: true,
  desc: 'Open a hidden-desktop session, optionally launching an AHK script or any exe into it, and keep it alive for step-by-step driving.',
  args: {
    script: { type: 'string', positional: 0, desc: 'AutoHotkey v2 script to launch (optional)' },
    exe: { type: 'string', desc: 'launch any executable instead (non-AHK target)' },
    args: { type: 'array', desc: 'arguments for the script/exe' },
    cwd: { type: 'string', desc: 'working directory' },
    label: { type: 'string', desc: 'session/run label' },
    keepGoing: { type: 'boolean', desc: 'AHK error dialogs: press Continue instead of killing' },
    shotsEvery: { type: 'number', desc: 'auto desktop screenshot every N ms' },
    shotsOnWindow: { type: 'boolean', desc: 'screenshot every window as it appears' },
    waitMs: { type: 'number', default: 5000, desc: 'wait up to N ms for the first window' },
    patch: { type: 'array', desc: 'patch recipes for the shadow copy' },
    probe: { type: 'boolean', desc: 'inject AhkProbe in RPC mode (enables guis/fire/call/var/hotkey.list verbs)' },
    overlay: { type: 'boolean', desc: 'run a shadow copy of the script folder (writes to A_ScriptDir never touch the original)' },
    env: { type: 'json', desc: 'extra environment as JSON' },
    rules: { type: 'json', desc: 'extra dialog rules' },
  },
  async run(ctx, a) {
    const label = a.label || (a.script ? path.basename(a.script, path.extname(a.script)) : a.exe ? path.basename(a.exe) : 'session');
    const s = await Session.open(ctx, { label, kind: 'session', keepGoing: a.keepGoing, rules: a.rules || [], shots: { everyMs: a.shotsEvery || 0, onWindow: !!a.shotsOnWindow } });
    ctx.sessions.set(s.id, s); ctx.state.current = s.id;
    try {
      if (a.script) {
        const script = assertScript(path.resolve(ctx.cwd, a.script));
        const { exe } = resolveAhk(ctx.cfg, script);
        const prepared = await prepareTarget(ctx, s, script, { patch: a.patch, probe: a.probe ? 'rpc' : false, overlay: a.overlay ? 'always' : 'auto' });
        s.prepared = prepared;
        s.hooks.onClose.push(async (sess) => { harvestAhkText(sess, 'main', { linemap: prepared.linemap }); harvestProbeErrors(sess, 'main'); if (prepared.after) await prepared.after(sess); if (prepared.cleanup) await prepared.cleanup(); });
        s.run.meta.script = script; s.run.meta.ahk = exe;
        await s.launch({ name: 'main', exe, cwd: a.cwd || prepared.cwd, scriptName: scriptNameOf(script), expect: 'running', args: ahkArgs({ script: prepared.entry, scriptArgs: a.args || [], includes: prepared.includes || [] }), env: { ...(prepared.env || {}), ...(a.env || {}) } });
      } else if (a.exe) {
        await s.launch({ name: 'main', exe: path.resolve(ctx.cwd, a.exe), cwd: a.cwd, expect: 'running', args: a.args || [], env: a.env });
      }
      if (s.procs.size && a.waitMs) {
        const p = s.proc('main');
        const t0 = Date.now();
        while (Date.now() - t0 < a.waitMs && !p.exited && ![...s.windows.values()].some((w) => w.alive && w.visible && w.kind !== 'tooltip')) await sleep(50);
        if (![...s.windows.values()].some((w) => w.ready)) await sleep(350);   // let the first window settle + be handled
      }
    } catch (e) { s.addFinding({ severity: 'error', kind: 'host-error', message: e.message }); }
    const wins = [...s.windows.values()].filter((w) => w.alive && w.visible);
    const lines = [statusText(s)];
    for (const w of wins) { const ref = s.procs.size ? s._refWin(w.hwnd) : ''; lines.push(`  ${ref.padEnd(3)} window ${w.hwnd} ${w.kind || ''} "${truncate(w.title, 50)}" [${w.class}]`); }
    for (const f of s.run.findings.filter((x) => x.severity === 'error').slice(0, 3)) lines.push(`  ✗ ${f.kind}: ${truncate(f.message, 200)}`);
    return { ok: true, summary: lines.join('\n'), data: { session: s.id, run: s.dir }, session: s.id };
  },
});

defineVerb({
  name: 'session.stop', group: 'session', needsHub: true, desc: 'Close the session: stop processes, write the evidence bundle, return the verdict.',
  args: { ...T, summary: { type: 'string', desc: 'summary line to record' }, noFinalShot: { type: 'boolean', desc: 'skip the final screenshot' } },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    const result = await s.close({ summary: a.summary || '', finalShot: !a.noFinalShot });
    ctx.sessions.delete(s.id); if (ctx.state.current === s.id) ctx.state.current = [...ctx.sessions.keys()].pop();
    result.runDir = s.dir;
    return { verdict: result.verdict, summary: formatRun(result), data: result, runDir: s.dir, exitCode: VERDICT_EXIT[result.verdict] ?? 1 };
  },
});

defineVerb({
  name: 'session.list', group: 'session', needsHub: true, desc: 'List open sessions.', args: {},
  async run(ctx) {
    const rows = [...ctx.sessions.values()].map((s) => statusText(s));
    return { ok: true, summary: rows.length ? rows.join('\n') : '(no open sessions)', data: { sessions: [...ctx.sessions.keys()], current: ctx.state.current } };
  },
});

defineVerb({
  name: 'status', group: 'session', needsHub: true, desc: 'Session status: processes, windows, dialogs, findings so far.', args: { ...T },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    const wins = await s.windowsList({}).catch(() => []);
    return { ok: true, summary: statusText(s) + '\n' + renderWindows(wins), data: { findings: s.run.findings, windows: wins } };
  },
});

defineVerb({
  name: 'hub.serve', group: 'internal', local: true, mcp: false, desc: 'Run the hub daemon (started automatically).', args: {},
  async run(ctx) {
    const { serveHub } = await import('../hub.mjs');
    const { makeContext } = await import('../cli.mjs');
    await serveHub(() => makeContext({ cwd: ctx.cwd, project: ctx.cfg.projectFile }));
  },
});

defineVerb({
  name: 'hub.stop', group: 'session', needsHub: true, desc: 'Stop the hub (closes all sessions).', args: {},
  async run(ctx) { setTimeout(() => ctx.hubShutdown?.(), 50); return { ok: true, summary: 'hub stopping' }; },
});

defineVerb({
  name: 'launch', group: 'session', needsHub: true, desc: 'Launch another process (script or exe) into the open session.',
  args: { ...T, script: { type: 'string', positional: 0, desc: 'AHK script' }, exe: { type: 'string', desc: 'any exe' }, args: { type: 'array' }, name: { type: 'string' }, cwd: { type: 'string' } },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    let name;
    if (a.script) {
      const script = assertScript(path.resolve(ctx.cwd, a.script)); const { exe } = resolveAhk(ctx.cfg, script);
      name = await s.launch({ name: a.name, exe, cwd: a.cwd || path.dirname(script), scriptName: scriptNameOf(script), expect: 'running', args: ahkArgs({ script, scriptArgs: a.args || [] }) });
    } else name = await s.launch({ name: a.name, exe: path.resolve(ctx.cwd, a.exe), cwd: a.cwd, expect: 'running', args: a.args || [] });
    return { ok: true, summary: `launched ${name} (pid ${s.proc(name).pid})` };
  },
});

// ---------------------------------------------------------------------- inspect

defineVerb({
  name: 'windows', group: 'inspect', needsHub: true, desc: 'List windows on the session desktop (refs, class, title, rect, responsiveness).',
  args: { ...T, all: { type: 'boolean', desc: 'include hidden windows' }, proc: { type: 'string' } },
  async run(ctx, a) { const s = getSession(ctx, a); const l = await s.windowsList({ proc: a.proc, all: a.all }); return { ok: true, summary: renderWindows(l), data: l }; },
});

defineVerb({
  name: 'tree', group: 'inspect', needsHub: true, desc: 'Win32 control tree of a window with refs (w1.4), kinds, text, state and rects.',
  args: { ...T, target: { ...TARGET, positional: 0 }, all: { type: 'boolean', desc: 'include hidden controls' }, save: { type: 'boolean', desc: 'also store as a run artifact' } },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    const t = a.save ? await s.snapshot('tree', a.target) : await s.tree(a.target);
    return { ok: true, summary: renderTree(t, { all: a.all }), data: t };
  },
});

defineVerb({
  name: 'uia', group: 'inspect', needsHub: true, desc: 'UI Automation tree of a window (names, automation ids, patterns, values).',
  args: { ...T, target: { ...TARGET, positional: 0 }, depth: { type: 'number', default: 6 } },
  async run(ctx, a) {
    const s = getSession(ctx, a); const t = await s.uia(a.target, { depth: a.depth });
    const L = t.nodes.map((n) => `${'  '.repeat((n.path === 'root' ? 0 : n.path.split('/').length))}${n.path.padEnd(8)} ${n.controlType} ${n.name ? `"${truncate(n.name, 40)}"` : ''} ${n.automationId ? '#' + n.automationId : ''} ${n.patterns.length ? '[' + n.patterns.join(',') + ']' : ''}${n.value !== undefined ? ' value=' + JSON.stringify(truncate(n.value, 30)) : ''}${n.toggle ? ' ' + n.toggle : ''}${n.offscreen ? ' offscreen' : ''}`);
    return { ok: true, summary: L.join('\n'), data: t };
  },
});

defineVerb({
  name: 'find', group: 'inspect', needsHub: true, desc: 'Find controls/windows by selector (kind:text, class=Edit, text~=regex, id=2, index=N).',
  args: { ...T, selector: { type: 'string', positional: 0, required: true }, all: { type: 'boolean' } },
  async run(ctx, a) {
    const s = getSession(ctx, a); const hits = await s.find(a.selector, { all: a.all });
    return { ok: hits.length > 0, summary: hits.length ? hits.map((h) => `${h.ref || ''} ${h.hwnd} ${h.kind || 'window'} "${truncate(h.text ?? h.title, 40)}" ${h.isWindow ? rc(h.rect) : rcw(h.rect)}`).join('\n') : `no match for ${a.selector}`, data: hits };
  },
});

defineVerb({
  name: 'at', group: 'inspect', needsHub: true, desc: 'What window/control is at screen point x,y on the session desktop.',
  args: { ...T, x: { type: 'number', positional: 0, required: true }, y: { type: 'number', positional: 1, required: true } },
  async run(ctx, a) {
    const s = getSession(ctx, a); const r = await s.host.request('win.at', { x: a.x, y: a.y });
    return { ok: r.hit, summary: r.hit ? r.chain.map((w, i) => `${'  '.repeat(i)}${w.hwnd} ${w.class} "${truncate(w.title, 40)}"`).join('\n') : 'nothing there', data: r };
  },
});

defineVerb({
  name: 'metrics', group: 'inspect', needsHub: true, desc: 'CPU/memory/handle/GDI/USER counts of the process tree (leak trends).',
  args: { ...T, proc: { type: 'string' } },
  async run(ctx, a) {
    const s = getSession(ctx, a); const m = await s.metrics(a.proc);
    return { ok: true, summary: m.processes.map((p) => `${p.name}(${p.pid}) ws=${p.workingSetMB}MB priv=${p.privateMB}MB handles=${p.handles} threads=${p.threads} gdi=${p.gdi} user=${p.user} cpu=${p.cpuMs}ms`).join('\n'), data: m };
  },
});

defineVerb({
  name: 'guard', group: 'inspect', needsHub: true, desc: 'Focus/clipboard/leak guard report for the real desktop.', args: { ...T },
  async run(ctx, a) {
    const g = await getSession(ctx, a).guard();
    return { ok: g.count === 0, summary: `violations: ${g.count} · foreground changed: ${g.foregroundChanged} · cursor moved (info): ${g.cursorMoved} · clipboard changed by target: ${g.clipboardChangedByTarget}${g.violations.map((v) => `\n  ✗ ${v.kind} ${v.class || ''} "${v.title || ''}"`).join('')}`, data: g };
  },
});

defineVerb({
  name: 'findings', group: 'inspect', needsHub: true, desc: 'Findings recorded so far in the session.', args: { ...T, severity: { type: 'string', desc: 'error|warn|info' } },
  async run(ctx, a) {
    const s = getSession(ctx, a); const l = s.run.findings.filter((f) => !a.severity || f.severity === a.severity);
    return { ok: true, summary: l.map((f) => `${f.id} ${f.severity} ${f.kind}: ${truncate(f.message, 200)}`).join('\n') || '(none)', data: l };
  },
});

defineVerb({
  name: 'events', group: 'inspect', needsHub: true, desc: 'Tail the session event log (events.jsonl).', args: { ...T, last: { type: 'number', default: 25 }, kind: { type: 'string', desc: 'substring filter on event kind' } },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    let lines = readText(s.run.eventsPath).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (a.kind) lines = lines.filter((e) => e.kind.includes(a.kind));
    lines = lines.slice(-a.last);
    return { ok: true, summary: lines.map((e) => `${String(e.t).padStart(6)}ms ${e.kind} ${truncate(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['t', 'ts', 'kind'].includes(k)))), 200)}`).join('\n'), data: lines };
  },
});

// ---------------------------------------------------------------------- vision

/** Extra summary lines for a composed shot: how each window was obtained, what could not be read. */
function composeNotes(r) {
  let s = '';
  if (r.layers) {
    const odd = r.layers.filter((l) => l.method !== 'dwm-thumbnail');
    s += `\n  ${r.layers.length} window(s) composed in ${r.composeMs}ms` + (odd.length ? ': ' + odd.map((l) => `${l.class} via ${l.method}`).join(', ') : '');
  }
  if (r.unexcluded?.length) s += `\n  probe lifted the capture exclusion of ${r.unexcluded.length} window(s) for this shot`;
  if (r.unreadable?.length) s += '\n  ⚠ unreadable (drawn hatched magenta): ' + r.unreadable.map((u) => `${u.class} ${u.hwnd} (${u.why})`).join('; ');
  return s;
}

defineVerb({
  name: 'shot', group: 'vision', needsHub: true,
  desc: 'Screenshot of the desktop, a window, or a control; optionally a closeup rect and scale. Never appears on your screen.',
  args: {
    ...T, target: { ...TARGET, positional: 0 }, desktop: { type: 'boolean', desc: 'whole hidden desktop' }, label: { type: 'string' },
    rect: { type: 'array', greedy: 4, desc: 'closeup rect x,y,w,h (relative to the window unless --screen-rect)' }, screenRect: { type: 'boolean' },
    scale: { type: 'number', desc: 'scale factor, e.g. 2 to magnify a closeup' }, maxEdge: { type: 'number', desc: 'downscale so the longest edge <= N px' },
    client: { type: 'boolean', desc: 'client area only' }, tech: { type: 'string', desc: 'auto|composed|printwindow-full|printwindow|windowdc|screen|bitblt|composite' },
    composed: { type: 'boolean', desc: 'what the SCREEN shows there: every window DWM-rendered (layered alpha, DirectComposition, thumbnails) in z-order (default for the desktop)' },
    isolate: { type: 'boolean', desc: 'with a window target: only that window, DWM-rendered with its real alpha, over --bg' },
    bg: { type: 'string', desc: 'composed background: wallpaper (desktop default) | checker (window default) | transparent | #RRGGBB' },
    flush: { type: 'boolean', desc: 'DwmFlush before each window render (only if a fresh change is missing)' },
  },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    const r = await s.shot({ target: a.target, desktop: a.desktop, label: a.label, rect: a.rect?.map(Number), screenRect: a.screenRect, scale: a.scale, maxEdge: a.maxEdge ?? ctx.cfg.shots.maxEdge, client: a.client, tech: a.tech, composed: a.composed, isolate: a.isolate, bg: a.bg, flush: a.flush });
    return { ok: !r.blank, summary: `${r.path}\n  ${r.width}x${r.height} via ${r.technique}${r.blank ? '  ⚠ looks blank (try --composed --isolate, or --tech printwindow)' : ''}${composeNotes(r)}`, images: [r.path], data: r };
  },
});

defineVerb({
  name: 'burst', group: 'vision', needsHub: true, desc: 'Take N screenshots at an interval and stitch them into one contact sheet (timestamps + labels).',
  args: { ...T, target: { ...TARGET, positional: 0 }, count: { type: 'number', default: 6 }, every: { type: 'number', default: 300, desc: 'ms between shots' }, cols: { type: 'number', default: 3 }, maxEdge: { type: 'number', default: 900 } },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    const shots = await s.burst({ count: a.count, everyMs: a.every, target: a.target, maxEdge: a.maxEdge });
    const sheet = await s.sheet({ files: shots.map((x) => x.path), cols: a.cols, cellWidth: Math.max(240, Math.round(1500 / a.cols)) });
    return { ok: true, summary: `contact sheet: ${sheet.path}  (${shots.length} frames, ${sheet.width}x${sheet.height})`, images: [sheet.path], data: { shots, sheet } };
  },
});

defineVerb({
  name: 'sheet', group: 'vision', needsHub: true, desc: 'Combine the last N screenshots of the session into one labelled contact sheet.',
  args: { ...T, last: { type: 'number', default: 6 }, cols: { type: 'number', default: 3 } },
  async run(ctx, a) { const s = getSession(ctx, a); const r = await s.sheet({ last: a.last, cols: a.cols }); return { ok: true, summary: `${r.path} (${r.cells} frames)`, images: [r.path], data: r }; },
});

defineVerb({
  name: 'marks', group: 'vision', needsHub: true,
  desc: 'Annotated screenshot: numbered boxes over every control, plus a legend mapping numbers to refs ("set of marks").',
  args: { ...T, target: { ...TARGET, positional: 0 }, all: { type: 'boolean', desc: 'include invisible controls' } },
  async run(ctx, a) {
    const s = getSession(ctx, a); const r = await s.annotate({ target: a.target, includeInvisible: a.all });
    return { ok: true, summary: `${r.path}\n` + r.marks.map((m) => `  ${String(m.n).padStart(2)}  ${m.ref}  ${m.label}`).join('\n'), images: [r.path], data: { marks: r.marks } };
  },
});

// ---------------------------------------------------------------------- input

const ACT = { ...T, target: { ...TARGET, positional: 0, required: true } };
const rep = (r) => (r === undefined ? '' : ' ' + truncate(JSON.stringify(r), 200));

defineVerb({
  name: 'click', group: 'input', needsHub: true, desc: 'Click a control/window (message based: never moves your mouse). Optional x,y relative to the window.',
  args: { ...ACT, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', default: 'left' }, double: { type: 'boolean' }, exact: { type: 'boolean', desc: 'send to the target itself, not the child under the point' } },
  async run(ctx, a) { const s = getSession(ctx, a); const r = await s.click(a.target, { x: a.x, y: a.y, button: a.button, double: a.double, exact: a.exact }); s.run.event('act.click', { target: a.target, r }); return { ok: true, summary: `clicked ${a.target} → ${r.class} @${r.clientX},${r.clientY}`, data: r }; },
});
defineVerb({
  name: 'mouse', group: 'input', needsHub: true,
  desc: "Synthetic mouse at SCREEN x,y on the hidden desktop, routed like real input: the desktop's own hit-testing (click-through and alpha-0 layered pixels fall to the window below), WM_NCHITTEST, hover (WM_SETCURSOR/WM_MOUSEMOVE, WM_MOUSELEAVE to the window left), then click|double|down|up|wheel. With --probe the script's GetCursorPos/MouseGetPos follow it. Never moves your mouse.",
  args: { ...T, action: { type: 'string', positional: 0, default: 'move', desc: 'move | click | double | down | up | wheel' }, x: { type: 'number', positional: 1 }, y: { type: 'number', positional: 2 },
    button: { type: 'string', default: 'left' }, delta: { type: 'number', default: -120, desc: 'wheel: +120 up, -120 down' } },
  async run(ctx, a) {
    const s = getSession(ctx, a);
    const r = await s.host.request('win.mouse', { action: a.action, x: a.x, y: a.y, button: a.button, delta: a.delta });
    s.run.event('act.mouse', { action: a.action, x: r.x, y: r.y, hit: r.hit, hitTest: r.hitTest });
    let sum = `${a.action} ${r.x},${r.y} → ${r.class || 'nothing'} ${r.hit} (${r.hitTest}) in "${r.topTitle || r.topClass || ''}"`;
    if (r.passedThrough) sum += `\n  passed through ${r.passedThrough.class} ${r.passedThrough.hwnd} "${r.passedThrough.title}" (click-through / transparent pixels)`;
    if (r.skipped?.length) sum += `\n  skipped (HTTRANSPARENT): ` + r.skipped.map((k) => `${k.class} ${k.hwnd}`).join(', ');
    if (r.note) sum += `\n  ${r.note}`;
    return { ok: true, summary: sum, data: r };
  },
});
defineVerb({
  name: 'press', group: 'input', needsHub: true, desc: 'Press a button control (BM_CLICK, posted so a modal dialog cannot block the harness).', args: { ...ACT },
  async run(ctx, a) { const s = getSession(ctx, a); const r = await s.press(a.target); s.run.event('act.press', { target: a.target }); return { ok: r.posted, summary: `pressed ${r.class} "${r.text}"`, data: r }; },
});
defineVerb({
  name: 'type', group: 'input', needsHub: true, desc: 'Post characters (WM_CHAR) to a control, as if typed.', args: { ...ACT, text: { type: 'string', positional: 1, required: true } },
  async run(ctx, a) { const s = getSession(ctx, a); const r = await s.type(a.target, a.text); s.run.event('act.type', { target: a.target, text: a.text }); return { ok: true, summary: `typed ${r.posted} char(s)`, data: r }; },
});
defineVerb({
  name: 'text', group: 'input', needsHub: true, desc: 'Set (or append to) the text of an edit control and notify the parent (EN_CHANGE).', args: { ...ACT, text: { type: 'string', positional: 1, required: true }, append: { type: 'boolean' } },
  async run(ctx, a) { const s = getSession(ctx, a); const r = await s.setText(a.target, a.text, a.append ? 'append' : 'replace'); s.run.event('act.text', { target: a.target, text: a.text }); return { ok: r.ok, summary: `text is now "${truncate(r.text, 80)}"`, data: r }; },
});
defineVerb({
  name: 'key', group: 'input', needsHub: true, desc: 'Post a key (Enter, Tab, Esc, F5, a, ...) to a window/control. mods: ctrl,shift,alt.', args: { ...ACT, key: { type: 'string', positional: 1, required: true }, mods: { type: 'array' }, repeat: { type: 'number' } },
  async run(ctx, a) { const s = getSession(ctx, a); const r = await s.key(a.target, a.key, { mods: a.mods || [], repeat: a.repeat }); s.run.event('act.key', { target: a.target, key: a.key }); return { ok: true, summary: `key ${a.key} posted`, data: r }; },
});
defineVerb({
  name: 'select', group: 'input', needsHub: true, desc: 'Choose an item in a ComboBox/ListBox/Tab by index or text.', args: { ...ACT, index: { type: 'number' }, text: { type: 'string' } },
  async run(ctx, a) { const s = getSession(ctx, a); const r = await s.select(a.target, { index: a.index ?? -1, text: a.text }); s.run.event('act.select', { target: a.target, index: a.index, text: a.text }); return { ok: true, summary: `selected index ${r.index}`, data: r }; },
});
defineVerb({
  name: 'check', group: 'input', needsHub: true, desc: 'Set a checkbox/radio: --state true|false|toggle.', args: { ...ACT, state: { type: 'string', default: 'toggle' } },
  async run(ctx, a) { const s = getSession(ctx, a); const r = await s.check(a.target, a.state); s.run.event('act.check', { target: a.target, state: a.state }); return { ok: true, summary: `was ${r.was ? 'checked' : 'unchecked'}${r.toggled ? ', toggled' : ''}`, data: r }; },
});
defineVerb({
  name: 'window', group: 'input', needsHub: true, desc: 'Window actions: close | wmclose | minimize | maximize | restore | move (--x --y --w --h).',
  args: { ...T, action: { type: 'string', positional: 0, required: true }, target: { ...TARGET, positional: 1 }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
  async run(ctx, a) { const s = getSession(ctx, a); await s.winAction(a.action, a.target, { x: a.x, y: a.y, w: a.w, h: a.h }); s.run.event('act.window', { action: a.action, target: a.target }); return { ok: true, summary: `${a.action} sent` }; },
});
defineVerb({
  name: 'uia.act', group: 'input', needsHub: true, desc: 'UI Automation action: invoke | toggle | expand | collapse | select | setvalue | focus (by --path, --name or --automation-id).',
  args: { ...T, target: { ...TARGET, positional: 0 }, action: { type: 'string', default: 'invoke' }, path: { type: 'string' }, name: { type: 'string' }, automationId: { type: 'string' }, value: { type: 'string' } },
  async run(ctx, a) { const s = getSession(ctx, a); const r = await s.uiaAct(a.target, { action: a.action, path: a.path, name: a.name, automationId: a.automationId, value: a.value }); s.run.event('act.uia', { ...a }); return { ok: true, summary: `uia ${a.action}${r.timedOut ? ' (issued; target did not return — likely modal dialog)' : ' ok'}`, data: r }; },
});
defineVerb({
  name: 'msg', group: 'input', needsHub: true, desc: 'Raw window message (escape hatch): --msg 0x111 --wparam N --lparam N [--send].', args: { ...ACT, msg: { type: 'string', required: true }, wparam: { type: 'string', default: '0' }, lparam: { type: 'string', default: '0' }, send: { type: 'boolean' } },
  async run(ctx, a) { const s = getSession(ctx, a); const t = await s._target(a.target); const r = await s.host.request('win.msg', { ...t, msg: Number(a.msg), wparam: Number(a.wparam), lparam: Number(a.lparam), post: !a.send }); return { ok: true, summary: JSON.stringify(r), data: r }; },
});

// ---------------------------------------------------------------------- waits

defineVerb({
  name: 'wait', group: 'sync', needsHub: true,
  desc: 'Wait for: window | output | dialog | idle | exit | text(control text). No fixed sleeps in tests — wait for the condition.',
  args: { ...T, for: { type: 'string', positional: 0, required: true, desc: 'window|output|dialog|idle|exit|text' }, match: { type: 'string', positional: 1, desc: 'regex (window title / output line / control text)' }, kind: { type: 'string' }, class: { type: 'string' }, target: TARGET, timeout: { type: 'number', default: 10, desc: 'seconds' }, quiet: { type: 'number', default: 500, desc: 'idle: quiet ms' } },
  async run(ctx, a) {
    const s = getSession(ctx, a); const ms = a.timeout * 1000;
    try {
      switch (a.for) {
        case 'window': { const w = await s.waitWindow({ title: a.match, kind: a.kind, class: a.class }, ms); return { ok: true, summary: `window ${w.hwnd} ${w.kind || ''} "${truncate(w.title, 60)}"`, data: w }; }
        case 'output': { const l = await s.waitOutput(a.match, ms, { stream: 'any' }); return { ok: true, summary: `output: ${l}`, data: { line: l } }; }
        case 'dialog': { const d = await s.waitDialog(ms, a.kind); return { ok: true, summary: `dialog ${d.kind} "${d.title}": ${truncate(d.text, 120)}`, data: d }; }
        case 'idle': { const t = await s.waitIdle({ quietMs: a.quiet, timeout: ms }); return { ok: true, summary: `idle after ${Math.round(t)}ms` }; }
        case 'exit': { const p = await s.waitExit(undefined, ms); return { ok: true, summary: `exited ${p.exitCode}` }; }
        case 'text': {
          const re = new RegExp(a.match, 'i'); const end = Date.now() + ms;
          for (;;) { const t = await s.tree(a.target); const c = t.controls.find((x) => re.test(x.text || '')); if (c) return { ok: true, summary: `${c.ref} "${truncate(c.text, 60)}"`, data: c }; if (Date.now() > end) throw new AhkhError('timed out waiting for text', 'TIMEOUT'); await sleep(100); }
        }
        default: throw new AhkhError(`unknown wait type ${a.for}`, 'BADARG');
      }
    } catch (e) { if (e.code === 'TIMEOUT') return { ok: false, summary: `TIMEOUT: ${e.message}`, exitCode: 3 }; throw e; }
  },
});
