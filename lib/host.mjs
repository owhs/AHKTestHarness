// JSON-lines client for bin/ahkh-host.exe (the native hidden-desktop host).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { exists, AhkhError } from './util.mjs';

export class HostClient {
  /** @param {{exe:string, desktop?:string, imagesOnly?:boolean, onEvent?:(ev:object)=>void}} o */
  constructor(o) {
    this.exe = o.exe;
    this.desktop = o.desktop || null;
    this.imagesOnly = !!o.imagesOnly;
    this.onEvent = o.onEvent || (() => {});
    this.pending = new Map();
    this.nextId = 1;
    this.waiters = [];
    this.closed = false;
    this.stderr = '';
    this.ready = null;
  }

  async start(timeoutMs = 15000) {
    if (!exists(this.exe)) throw new AhkhError(`native host not built: ${this.exe} (run: powershell -File build.ps1)`, 'NOHOST');
    const args = [];
    if (this.desktop) args.push('--desktop', this.desktop);
    if (this.imagesOnly) args.push('--images-only');
    this.child = spawn(this.exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', (d) => { this.stderr += d.toString(); if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-10000); });
    this.child.on('exit', (code) => {
      this.closed = true; this.exitCode = code;
      for (const [, p] of this.pending) p.reject(new AhkhError(`host exited (code ${code})`, 'HOSTDEAD'));
      this.pending.clear();
      this._notify({ event: 'host.exit', code });
    });
    this.child.stdin.on('error', () => { /* host gone */ });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._line(line));
    this.ready = await this.waitEvent((e) => e.event === 'ready' || e.event === 'fatal', timeoutMs, 'host start');
    if (this.ready.event === 'fatal') throw new AhkhError(this.ready.message, 'HOSTFATAL');
    return this.ready;
  }

  _line(line) {
    let m;
    try { m = JSON.parse(line); } catch { this._notify({ event: 'host.garbage', text: line }); return; }
    if (m.id !== undefined && m.id !== null && this.pending.has(m.id)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(new AhkhError(m.error || 'host error', 'HOSTERR', { type: m.type }));
      return;
    }
    this._notify(m);
  }

  _notify(ev) {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      let hit = false;
      try { hit = w.pred(ev); } catch { /* ignore */ }
      if (hit) { this.waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(ev); }
    }
    try { this.onEvent(ev); } catch (e) { /* listener bugs must not kill the pump */ }
  }

  waitEvent(pred, timeoutMs = 10000, what = 'event') {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new AhkhError(`timed out waiting for ${what}`, 'TIMEOUT')); }, timeoutMs);
      this.waiters.push(w);
    });
  }

  request(cmd, args = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new AhkhError('host is not running', 'HOSTDEAD'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AhkhError(`host request timed out: ${cmd}`, 'TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  async close() {
    if (this.closed) return;
    try { await Promise.race([this.request('quit', {}, 3000), new Promise((r) => setTimeout(r, 3000))]); } catch { /* ignore */ }
    try { this.child.stdin.end(); } catch { /* ignore */ }
    await new Promise((r) => { if (this.closed) return r(); const t = setTimeout(() => { try { this.child.kill(); } catch { /* ignore */ } r(); }, 3000); this.child.once('exit', () => { clearTimeout(t); r(); }); });
  }
}
