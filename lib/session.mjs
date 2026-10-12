// A Session = one hidden desktop (native host) + one evidence run folder + the processes launched on it.
// Everything above this layer (CLI verbs, MCP tools, smoke tester) drives targets through a Session.
import fs from 'node:fs';
import path from 'node:path';
import { HostClient } from './host.mjs';
import { handleProbeLine } from './probe.mjs';
import { mapLine } from './adapters/ahk2.mjs';
import { Run, VERDICT_EXIT, worstVerdict } from './evidence.mjs';
import { sleep, pollUntil, shortId, truncate, readJson, readText, exists, joinArgs, AhkhError, ensureDir } from './util.mjs';

const KIND_VERDICT = {
  'ahk-error': 'ERROR', 'load-error': 'ERROR', 'runtime-error': 'ERROR', crash: 'CRASH', timeout: 'TIMEOUT', hung: 'HUNG',
  'guard-foreground': 'FOCUS-STOLEN', 'guard-clipboard': 'FOCUS-STOLEN', 'guard-leak': 'LEAK',
  'exit-code': 'FAIL', assertion: 'FAIL', dialog: 'DIALOG', 'host-error': 'ERROR',
};

export function loadDefaultRules(cfg, { keepGoing = false, extra = [] } = {}) {
  const base = readJson(path.join(cfg.harnessRoot, 'rules', 'default.json'), []);
  const rules = [...extra, ...(cfg.rules || []), ...base];
  return rules.map((r) => (keepGoing && r.name === 'ahk-error' ? { ...r, do: { ...r.do, press: { id: 11 } } } : r));
}

export class Session {
  static async open(ctx, { label = 'session', kind = 'session', rules = [], keepGoing, shots = {}, meta = {}, imagesOnly = false } = {}) {
    const s = new Session(ctx, { label, kind, imagesOnly });
    await s._open({ rules, keepGoing: keepGoing ?? ctx.cfg.keepGoing, shots, meta });
    return s;
  }

  constructor(ctx, { label, kind, imagesOnly }) {
    this.ctx = ctx; this.cfg = ctx.cfg; this.id = 's' + shortId(2);
    this.run = new Run(this.cfg, { label, kind });
    this.imagesOnly = imagesOnly;
    this.procs = new Map();          // name -> proc state
    this.windows = new Map();        // hwnd -> {hwnd, proc, class, title, kind, rect, alive, visible}
    this.dialogs = [];
    this.shots = [];
    this.refs = { win: new Map(), byRef: new Map(), n: 0 };
    this.lastActivity = performance.now();
    this.hooks = { onClose: [], onDialog: [], onProcExit: [] };
    this.closed = false;
    this.extra = {};                 // adapter-supplied result data
    this.hostErrors = [];
    this.host = new HostClient({ exe: this.cfg.hostExe, imagesOnly, onEvent: (e) => this._onEvent(e) });
  }

  get dir() { return this.run.dir; }

  async _open({ rules, keepGoing, shots, meta }) {
    Object.assign(this.run.meta, meta, { harness: 'ahkh 0.1.0' });
    this.run.event('session.open', { id: this.id, label: this.run.label });
    const ready = await this.host.start();
    this.run.meta.desktop = ready.desktop; this.run.meta.screen = ready.screen;
    if (!this.imagesOnly) {
      const sc = { ...this.cfg.shots, ...shots };
      await this.host.request('rules.set', { rules: loadDefaultRules(this.cfg, { keepGoing, extra: rules }) });
      await this.host.request('shots.auto', { dir: this.run.path('shots'), onDialog: sc.onDialog, onWindow: sc.onWindow, everyMs: sc.everyMs || 0, maxEdge: sc.maxEdge || 0, technique: sc.technique || 'auto' });
    }
    return ready;
  }

  // ------------------------------------------------------------------ events

  _onEvent(e) {
    if (this.closed && e.event !== 'host.exit') return;
    const kind = e.event;
    const quiet = kind === 'out' ? false : true;
    if (kind === 'out' || kind.startsWith('win.') || kind === 'dialog' || kind === 'shot' || kind === 'proc.exit') this.lastActivity = performance.now();
    const { event: _ev, ts: _ts, ...rest } = e;
    if (kind !== 'ready') this.run.event('host.' + kind, rest);
    switch (kind) {
      case 'out': {
        const p = this.procs.get(e.proc); if (!p) break;
        const arr = e.stream === 'err' ? p.err : p.out;
        arr.push(e.text); if (arr.length > 20000) arr.splice(0, arr.length - 15000);
        if (e.text.startsWith('AHKH|')) handleProbeLine(this, e.proc, e.text, (file, line) => mapLine(this.prepared?.linemap, file, line));
        break;
      }
      case 'proc.exit': {
        const p = this.procs.get(e.proc); if (!p) break;
        Object.assign(p, { exited: true, exitCode: e.code, exitHex: e.hex, exitName: e.name, killedBy: e.killedBy || p.killedBy, crashed: e.crashed, elapsedMs: e.elapsedMs });
        for (const h of this.hooks.onProcExit) { try { h(p, e); } catch { /* ignore */ } }
        break;
      }
      case 'proc.timeout': { const p = this.procs.get(e.proc); if (p) p.timedOut = true; break; }
      case 'win.new': this.windows.set(e.hwnd, { hwnd: e.hwnd, proc: e.proc, class: e.class, title: e.title, rect: e.rect, alive: true, visible: true, t: e.t }); break;
      case 'win.ready': { const w = this.windows.get(e.hwnd) || { hwnd: e.hwnd, proc: e.proc, alive: true }; Object.assign(w, { kind: e.kind, class: e.class, title: e.title, rect: e.rect, ready: true, children: e.children }); this.windows.set(e.hwnd, w); break; }
      case 'win.gone': { const w = this.windows.get(e.hwnd); if (w) { w.alive = false; w.visible = false; } break; }
      case 'win.hidden': { const w = this.windows.get(e.hwnd); if (w) w.visible = false; break; }
      case 'dialog': this._onDialog(e); break;
      case 'guard': this._onGuard(e); break;
      case 'hung': {
        const p = this.procs.get(e.proc); if (p) p.hung = true;
        this.run.addFinding({ severity: 'error', kind: 'hung', message: `process ${e.proc} unresponsive for ${e.forMs}ms (window ${e.hwnd})`, proc: e.proc });
        break;
      }
      case 'shot': {
        if (!e.path) break;
        if (!this.shots.find((s) => s.path === e.path)) {
          const rec = { path: e.path, label: e.label, target: e.target, technique: e.technique, blank: e.blank, t: e.t, w: e.w, h: e.h };
          this.shots.push(rec); this.run.artifact('shot', e.path, { label: e.label, technique: e.technique, blank: e.blank });
        }
        break;
      }
      case 'error': this.hostErrors.push(e); this.run.addFinding({ severity: 'warn', kind: 'host-error', message: `${e.where}: ${e.message}` }); break;
      case 'host.exit': if (!this.closed) this.run.addFinding({ severity: 'error', kind: 'host-error', message: `native host exited unexpectedly (code ${e.code})` }); break;
      default: break;
    }
    void quiet;
  }

  _onDialog(e) {
    const n = this.run.next('dialog');
    const rec = { n, ...e };
    this.dialogs.push(rec);
    const rel = `dialogs/${String(n).padStart(3, '0')}.json`;
    this.run.writeJson(rel, rec);
    this.run.artifact('dialog', this.run.path(rel), { kindOf: e.kind });
    const shot = e.shot || null;
    const text = String(e.text || '').trim();
    const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
    const base = { proc: e.proc, dialog: n, shot, title: e.title, action: e.action };
    if (e.kind === 'ahk-error') {
      const m = /▶\s*(\d+):/.exec(text);
      this.addFinding({ ...base, severity: 'error', kind: 'ahk-error', message: truncate(text.replace(/\r?\n\s*\r?\n/g, '\n').replace(/\n/g, ' | '), 500), line: m ? Number(m[1]) : undefined, file: e.title });
    } else if (e.kind === 'ahk-warning') {
      this.run.addFinding({ ...base, severity: 'warn', kind: 'ahk-warning', message: truncate(text.replace(/\n/g, ' | '), 400) });
    } else if (['msgbox', 'inputbox', 'fileselect', 'dialog'].includes(e.kind)) {
      this.run.addFinding({ ...base, severity: this.cfg.failOnDialog ? 'error' : 'info', kind: 'dialog', message: `${e.kind} "${e.title}": ${truncate(text.replace(/\n/g, ' | '), 300)} [buttons: ${(e.buttons || []).join('/')}] -> ${e.action}` });
    }
    for (const h of this.hooks.onDialog) { try { h(rec); } catch { /* ignore */ } }
  }

  _onGuard(e) {
    if (e.kind === 'clipboard-touched') {
      // The sandbox cannot stop a script EMPTYING the clipboard; the host restores the user's content instantly. Report it, but it is
      // only a failure if the restore did not work.
      this.clipTouches = (this.clipTouches || 0) + 1;
      this.run.addFinding({ severity: e.restored ? 'warn' : 'error', kind: e.restored ? 'clipboard-touched' : 'guard-clipboard', message: e.restored ? 'target emptied the clipboard; your clipboard content was restored' : 'target emptied the clipboard and it could NOT be restored', signature: 'clipboard-touched' });
      return;
    }
    if (e.kind === 'console-blocked') {
      // A console program wanted a NEW console: Windows 11 would hand it to the default terminal (Windows Terminal), on the user's
      // desktop. The host killed that conhost before the handoff (native/Host.Console.cs); the program did not run.
      this.consolesBlocked = (this.consolesBlocked || 0) + 1;
      this.run.addFinding({ severity: 'warn', kind: 'console-blocked', message: e.message || `console blocked (client ${e.client || e.clientPid})`, proc: e.proc, signature: `console-blocked ${e.client || ''}` });
      return;
    }
    const map = { 'foreground-stolen': 'guard-foreground', 'window-on-user-desktop': 'guard-leak', 'console-delegated': 'guard-leak' };
    this.run.addFinding({ severity: 'error', kind: map[e.kind] || 'guard-leak', message: `${e.kind}: ${e.class || ''} "${e.title || ''}" ${e.hwnd || e.owner || ''}${e.message ? ' - ' + e.message : ''}`.trim(), hwnd: e.hwnd });
  }

  // ------------------------------------------------------------------ processes

  /** Launch a process on the hidden desktop. args: string or array. expect: 'exit' (default) | 'running'. */
  // console: true = a console program gets a visible console window ON THE HIDDEN DESKTOP (conhost.exe -- cmdline, never handed to
  // Windows Terminal); default: windowless console. Either way no console can reach the user's desktop (native/Host.Console.cs).
  async launch({ name, exe, args = [], cwd, env, timeoutMs, scriptName, expect = 'exit', show = 'na', stdin, cmdline, memMb, console: wantConsole } = {}) {
    name = name || 'p' + (this.procs.size + 1);
    const dir = ensureDir(this.run.path('procs', name));
    const p = { name, exe, args, out: [], err: [], exited: false, expect, files: { stdout: path.join(dir, 'stdout.txt'), stderr: path.join(dir, 'stderr.txt') }, startedT: this.run.now() };
    this.procs.set(name, p);
    const argStr = Array.isArray(args) ? joinArgs(args) : String(args || '');
    const res = await this.host.request('proc.start', {
      proc: name, exe, args: argStr, cwd, env, scriptName, show, cmdline, memMb, stdin, console: !!wantConsole,
      stdout: p.files.stdout, stderr: p.files.stderr, timeoutMs: expect === 'exit' ? (timeoutMs ?? this.cfg.timeoutMs) : 0,
    });
    p.pid = res.pid;
    this.run.event('proc.launch', { name, exe, args: argStr, cwd, pid: res.pid, expect });
    return name;
  }

  proc(name) { const p = name ? this.procs.get(name) : [...this.procs.values()][0]; if (!p) throw new AhkhError(`no such process: ${name}`, 'NOPROC'); return p; }

  async waitExit(name, ms = 20000, { soft = false } = {}) {
    const p = this.proc(name);
    try { await pollUntil(() => p.exited, { timeout: ms, interval: 25, message: `process ${p.name} did not exit within ${ms}ms` }); }
    catch (e) { if (soft) return null; throw e; }
    return p;
  }

  async kill(name, reason = 'requested') {
    const p = this.proc(name); if (p.exited) return p;
    p.killedBy = p.killedBy || reason;
    try { await this.host.request('proc.kill', { proc: p.name, reason }); } catch { /* already gone */ }
    await pollUntil(() => p.exited, { timeout: 4000, interval: 25 }).catch(() => {});
    return p;
  }

  // ------------------------------------------------------------------ waits (state based: no lost-event races)

  async waitWindow(match = {}, ms = 10000) {
    const test = (w) => w.alive && w.visible && (!match.proc || w.proc === match.proc) && (!match.kind || w.kind === match.kind) &&
      (!match.class || new RegExp(match.class, 'i').test(w.class || '')) && (!match.title || new RegExp(match.title, 'i').test(w.title || ''));
    const hit = await pollUntil(() => [...this.windows.values()].find(test), { timeout: ms, interval: 30, message: `no window matching ${JSON.stringify(match)} within ${ms}ms` });
    return hit;
  }

  async waitOutput(rx, ms = 10000, { proc, stream = 'out', since = 0 } = {}) {
    const re = rx instanceof RegExp ? rx : new RegExp(rx, 'i');
    return pollUntil(() => {
      for (const p of this.procs.values()) {
        if (proc && p.name !== proc) continue;
        const arr = stream === 'err' ? p.err : stream === 'any' ? [...p.out, ...p.err] : p.out;
        for (let i = since; i < arr.length; i++) if (re.test(arr[i])) return arr[i];
      }
      return null;
    }, { timeout: ms, interval: 30, message: `output /${re.source}/ not seen within ${ms}ms` });
  }

  async waitDialog(ms = 10000, kind) {
    const before = this.dialogs.length;
    return pollUntil(() => this.dialogs.slice(before).find((d) => !kind || d.kind === kind), { timeout: ms, interval: 30, message: 'no dialog appeared' });
  }

  /** Idle = no window/output/dialog activity for quietMs. */
  async waitIdle({ quietMs = 500, timeout = 10000 } = {}) {
    const start = performance.now();
    for (;;) {
      if (performance.now() - this.lastActivity >= quietMs) return performance.now() - start;
      if (performance.now() - start > timeout) throw new AhkhError(`not idle after ${timeout}ms`, 'TIMEOUT');
      await sleep(30);
    }
  }

  // ------------------------------------------------------------------ inspection

  async windowsList({ proc, all = false } = {}) {
    const list = await this.host.request('win.list', { proc, visible: !all });
    for (const w of list) w.ref = this._refWin(w.hwnd);
    return list;
  }

  _refWin(hwnd) {
    if (!this.refs.win.has(hwnd)) { this.refs.win.set(hwnd, 'w' + (++this.refs.n)); }
    const r = this.refs.win.get(hwnd); this.refs.byRef.set(r, hwnd); return r;
  }

  async tree(target = {}) {
    const t = await this.host.request('win.tree', await this._target(target), 30000);
    t.ref = this._refWin(t.hwnd);
    t.controls.forEach((c, i) => { c.ref = `${t.ref}.${i}`; this.refs.byRef.set(c.ref, c.hwnd); });
    this.lastTree = t;
    return t;
  }

  async uia(target = {}, opts = {}) { return this.host.request('uia.tree', { ...(await this._target(target)), ...opts }, 40000); }

  async snapshot(label = 'snap', target = {}) {
    const n = this.run.next('tree');
    const tree = await this.tree(target);
    const rel = `trees/${String(n).padStart(3, '0')}_${label}.json`;
    this.run.writeJson(rel, tree); this.run.artifact('tree', this.run.path(rel), { label });
    return tree;
  }

  /** Resolve a target spec to host arguments: {hwnd} or {proc}. Accepts ref (w1, w1.4), 0xHWND, proc:name, selector, or an object. */
  async _target(spec) {
    if (!spec || (typeof spec === 'object' && !spec.selector && !spec.ref && !spec.hwnd && !spec.proc && !spec.desktop)) {
      const first = [...this.procs.values()].find((p) => !p.exited) || [...this.procs.values()][0];
      return first ? { proc: first.name } : {};
    }
    if (typeof spec === 'object') {
      if (spec.hwnd) return { hwnd: spec.hwnd };
      if (spec.ref) return this._target(spec.ref);
      if (spec.proc) return { proc: spec.proc };
      if (spec.desktop) return { desktop: true };
      if (spec.selector) return this._target(spec.selector);
    }
    const s = String(spec);
    if (/^0x[0-9a-f]+$/i.test(s)) return { hwnd: s };
    if (/^w\d+(\.\d+)?$/.test(s)) {
      let h = this.refs.byRef.get(s);
      if (!h) {   // refs are assigned when windows/controls are listed: do that on demand so `w1` works right after session.start
        const winRef = s.split('.')[0];
        if (!this.refs.byRef.get(winRef)) await this.windowsList({}).catch(() => []);
        if (s.includes('.') && this.refs.byRef.get(winRef)) await this.tree({ hwnd: this.refs.byRef.get(winRef) }).catch(() => null);
        h = this.refs.byRef.get(s);
      }
      if (!h) throw new AhkhError(`unknown ref ${s} (list windows/controls first: windows, tree)`, 'NOREF');
      return { hwnd: h };
    }
    if (/^proc:/.test(s)) return { proc: s.slice(5) };
    if (s === 'desktop') return { desktop: true };
    const hits = await this.find(s);
    if (!hits.length) throw new AhkhError(`nothing matches selector: ${s}`, 'NOMATCH');
    return { hwnd: hits[0].hwnd };
  }

  /** Selector: `button:OK` (kind:text) or `key=value&key~=regex&key!=value` with keys kind,class,text,title,id,index,proc. */
  async find(selector, { all = false } = {}) {
    const pred = parseSelector(selector);
    const out = [];
    const wins = await this.windowsList({});
    for (const w of wins) {
      if (pred.matchWin(w)) out.push({ ...w, isWindow: true });
      let tree; try { tree = await this.tree({ hwnd: w.hwnd }); } catch { continue; }
      for (const c of tree.controls) if (pred.matchCtl(c, w)) out.push({ ...c, window: w.ref, windowTitle: w.title });
    }
    const idx = pred.index;
    if (idx != null) return out[idx] ? [out[idx]] : [];
    return all ? out : out.slice(0, 1);
  }

  // ------------------------------------------------------------------ vision + input

  async shot(o = {}) {
    const t = await this._target(o.target ?? (o.desktop ? 'desktop' : undefined));
    const args = { ...t, label: o.label, rect: o.rect, scale: o.scale, maxEdge: o.maxEdge, client: o.client, tech: o.composed ? 'composed' : o.tech, path: o.path, screenRect: o.screenRect, isolate: o.isolate, bg: o.bg, flush: o.flush };
    let r = await this.host.request('shot', args, 70000);
    if (r.unreadable?.length && this.probe && o.unexclude !== false) {
      // Windows excluded from capture (SetWindowDisplayAffinity) that DWM will not render for us: if they belong to the probed
      // script, let it lift its own exclusion for the moment of the shot (restored right after), then shoot again.
      let lifted = [];
      try { lifted = await this.probe.call('unexclude', {}, 4000); } catch { /* old probe / not ours / busy */ }
      if (Array.isArray(lifted) && lifted.length) {
        try { fs.rmSync(r.path, { force: true }); r = await this.host.request('shot', { ...args, path: r.path, flush: true }, 70000); r.unexcluded = lifted; }
        finally { try { await this.probe.call('reexclude', { windows: lifted }, 4000); } catch { /* the probe logs it */ } }
      }
    }
    if (!this.shots.find((s) => s.path === r.path)) { this.shots.push({ path: r.path, label: o.label, technique: r.technique, blank: r.blank, w: r.width, h: r.height }); this.run.artifact('shot', r.path, { label: o.label, technique: r.technique, blank: r.blank }); }
    return r;
  }

  async burst({ count = 5, everyMs = 300, target, label = 'burst', maxEdge } = {}) {
    const out = [];
    for (let i = 0; i < count; i++) { out.push(await this.shot({ target, label: `${label}${i + 1}`, maxEdge, desktop: !target })); if (i < count - 1) await sleep(everyMs); }
    return out;
  }

  async sheet({ files, last = 6, out, cols = 3, cellWidth = 480 } = {}) {
    const list = files || this.shots.filter((s) => !s.blank).slice(-last).map((s) => s.path);
    if (!list.length) throw new AhkhError('no screenshots to combine', 'NOSHOTS');
    const labels = list.map((f) => path.basename(f, '.png'));
    const dst = out || this.run.path('shots', `sheet_${String(this.run.next('sheet')).padStart(2, '0')}.png`);
    const r = await this.host.request('img.sheet', { files: list, labels, out: dst, cols, cellWidth });
    this.run.artifact('sheet', dst, { label: 'contact sheet' });
    return r;
  }

  async annotate({ target, label = 'marks', includeInvisible = false } = {}) {
    const tree = await this.tree(await this._target(target));
    const shot = await this.shot({ target: { hwnd: tree.hwnd }, label: label + '-raw' });
    const boxes = tree.controls.filter((c) => (includeInvisible || c.visible) && c.rect[2] > 2 && c.rect[3] > 2 && ['button', 'checkbox', 'radio', 'edit', 'combo', 'list', 'listview', 'treeview', 'tab', 'link', 'slider', 'datetime', 'web'].includes(c.kind))
      .map((c, i) => ({ rect: [c.rect[0], c.rect[1], c.rect[0] + c.rect[2], c.rect[1] + c.rect[3]], label: `${i}:${c.kind}${c.text ? ' ' + truncate(c.text, 14) : ''}`, ref: c.ref }));
    const dst = this.run.path('shots', `${String(this.run.next('marks')).padStart(3, '0')}_${label}.png`);
    await this.host.request('img.annotate', { src: shot.path, out: dst, boxes: boxes.map((b) => ({ rect: b.rect, label: b.label })), originX: 0, originY: 0 });
    this.run.artifact('shot', dst, { label });
    return { path: dst, marks: boxes.map((b, i) => ({ n: i, ref: b.ref, label: b.label })), tree };
  }

  async click(target, o = {}) { return this.host.request('win.click', { ...(await this._target(target)), ...o }); }
  async press(target) { return this.host.request('win.press', await this._target(target)); }
  async type(target, text) { return this.host.request('win.type', { ...(await this._target(target)), text }); }
  async setText(target, text, mode = 'replace') { return this.host.request('win.text', { ...(await this._target(target)), text, mode }); }
  async key(target, key, o = {}) { return this.host.request('win.key', { ...(await this._target(target)), key, ...o }); }
  async select(target, o) { return this.host.request('win.select', { ...(await this._target(target)), ...o }); }
  async check(target, state = 'toggle') { return this.host.request('win.check', { ...(await this._target(target)), state }); }
  async winAction(action, target, o = {}) { return this.host.request('win.' + action, { ...(await this._target(target)), ...o }); }
  async uiaAct(target, o) { return this.host.request('uia.act', { ...(await this._target(target)), ...o }, 30000); }
  async metrics(name) { return this.host.request('proc.metrics', { proc: this.proc(name).name }); }
  async guard() { return this.host.request('guard.report', {}); }

  // ------------------------------------------------------------------ finish

  addFinding(f) {
    if (f.kind === 'ahk-error' || f.kind === 'runtime-error') {
      // The probe reports an error on stdout AND AHK shows its dialog: one bug, one finding (keep the richer one, attach the shot).
      const norm = (m) => String(m || '').replace(/^Error:\s*/i, '').replace(/\s+/g, ' ').slice(0, 50).toLowerCase();
      const key = norm(f.message);
      const recent = this.run.findings.slice(-8).reverse().find((x) => (x.kind === 'ahk-error' || x.kind === 'runtime-error') && x.kind !== f.kind && this.run.now() - x.t < 2500 && norm(x.message) === key);
      if (recent) {
        if (f.shot && !recent.shot) recent.shot = f.shot;
        if (f.kind === 'runtime-error' && recent.kind === 'ahk-error') { recent.message = f.message; if (f.file) recent.file = f.file; if (f.line) recent.line = f.line; recent.stack = f.stack; recent.kind = 'runtime-error'; recent.merged = true; recent.signature = undefined; }
        return recent;
      }
    }
    return this.run.addFinding(f);
  }

  computeVerdict() {
    const vs = ['PASS'];
    for (const f of this.run.findings) {
      if (f.severity !== 'error') continue;
      vs.push(f.verdict || KIND_VERDICT[f.kind] || 'FAIL');
    }
    return worstVerdict(vs);
  }

  /** Stop everything, write the evidence bundle. Safe to call twice. */
  async close({ summary = '', finalShot = false, verdict } = {}) {
    if (this.closed) return this.run.result;
    if (finalShot && !this.imagesOnly) { try { await this.shot({ desktop: true, label: 'final' }); } catch { /* nothing to show */ } }
    for (const p of this.procs.values()) {
      if (!p.exited) { p.killedBy = p.killedBy || 'end-of-session'; await this.kill(p.name, 'end-of-session').catch(() => {}); }
    }
    await sleep(60);
    let guard = null;
    if (!this.imagesOnly && this.cfg.guard !== false) { try { guard = await this.guard(); } catch { /* host gone */ } }
    for (const h of this.hooks.onClose) { try { await h(this); } catch (e) { this.run.addFinding({ severity: 'warn', kind: 'host-error', message: 'close hook: ' + e.message }); } }
    // Generic exit-code finding, only when nothing more specific already explains a failure.
    for (const p of this.procs.values()) {
      const explained = this.run.findings.some((f) => f.severity === 'error' && (!f.proc || f.proc === p.name));
      if (p.crashed && !this.run.findings.some((f) => f.kind === 'crash' && f.proc === p.name))
        this.run.addFinding({ severity: 'error', kind: 'crash', proc: p.name, message: `process crashed: ${p.exitName || 'exception'} (${p.exitHex})` });
      else if (p.timedOut && p.expect === 'exit' && !this.run.findings.some((f) => f.kind === 'timeout'))
        this.run.addFinding({ severity: 'error', kind: 'timeout', proc: p.name, message: `process ${p.name} still running after ${this.cfg.timeoutMs}ms` });
      else if (p.exited && p.exitCode !== 0 && !explained && !p.killedBy && p.expect === 'exit')
        this.run.addFinding({ severity: 'error', kind: 'exit-code', proc: p.name, message: `exited with code ${p.exitCode}` });
    }
    const procInfo = {};
    for (const p of this.procs.values()) procInfo[p.name] = { pid: p.pid, exitCode: p.exitCode, exitName: p.exitName, killedBy: p.killedBy, elapsedMs: p.elapsedMs, stdout: this.run.rel(p.files.stdout), stderr: this.run.rel(p.files.stderr) };
    const v = verdict || this.computeVerdict();
    const errs = this.run.findings.filter((f) => f.severity === 'error');
    const autoSummary = summary || `${errs.length} error(s), ${this.run.findings.filter((f) => f.severity === 'warn').length} warning(s), ${this.dialogs.length} dialog(s), ${this.shots.length} shot(s)`;
    this.closed = true;
    const result = this.run.finish({ verdict: v, summary: autoSummary, data: { procs: procInfo, guard, dialogs: this.dialogs.length, shots: this.shots.length, exitCode: VERDICT_EXIT[v] ?? 1, ...this.extra } });
    await this.host.close();
    return result;
  }
}

// ---------------------------------------------------------------------- selectors

export function parseSelector(sel) {
  const s = String(sel).trim();
  const tests = []; let index = null;
  const parts = s.includes('=') || s.includes('~') ? s.split(/\s*&&?\s*/) : [s];
  for (const part of parts) {
    let m = /^([a-zA-Z]+)\s*(!=|~=|=~|=|~)\s*(.*)$/.exec(part);
    if (!m && /^[A-Za-z0-9_]+:/.test(part)) { const i = part.indexOf(':'); m = [null, 'kind', '=', part.slice(0, i)]; tests.push(mk('kind', '=', part.slice(0, i))); const t = part.slice(i + 1); if (t) tests.push(mk('text', '~', t.replace(/^\/|\/$/g, '') === t ? t : t.replace(/^\/|\/$/g, ''), true)); continue; }
    if (!m) { tests.push(mk('text', '=', part)); continue; }
    const [, k, op, v] = m;
    if (k === 'index') { index = Number(v); continue; }
    tests.push(mk(k, op, v));
  }
  function mk(key, op, val, exactish) {
    const rx = op === '~' || op === '~=' || op === '=~' ? new RegExp(val, 'i') : null;
    return { key, op, val, rx, exactish };
  }
  const get = (o, key) => {
    switch (key) {
      case 'title': return o.title ?? o.text ?? '';
      case 'text': return (o.text ?? o.title ?? '').replace(/&/g, '');
      case 'class': return o.class ?? '';
      case 'kind': return o.kind ?? '';
      case 'id': return String(o.id ?? '');
      case 'proc': return o.proc ?? '';
      default: return String(o[key] ?? '');
    }
  };
  const run = (o) => tests.every((t) => {
    const v = get(o, t.key);
    if (t.op === '!=') return v.toLowerCase() !== t.val.toLowerCase();
    if (t.rx) return t.rx.test(v);
    return v.toLowerCase() === t.val.toLowerCase();
  });
  return { index, matchWin: (w) => run({ ...w, kind: w.kind || 'window' }), matchCtl: (c) => run(c) };
}
