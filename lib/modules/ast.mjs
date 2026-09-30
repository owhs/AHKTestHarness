// Client for the vendored AST engine (AstHost.exe: parse / outline / errors / edit / flow over JSON lines).
// It has no windows (GUI subsystem, never a console) and never runs scripts, so it can live on the normal desktop.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { findAstHost } from '../config.mjs';
import { AhkhError, readJson } from '../util.mjs';

export class AstClient {
  constructor(cfg) { this.cfg = cfg; this.pending = new Map(); this.nextId = 1; }

  async start() {
    const exe = findAstHost(this.cfg);
    if (!exe) throw new AhkhError('AstHost.exe not found (vendor/ast/AstHost.exe)', 'NOAST');
    this.exe = exe;
    this.child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
      if (m.ok) p.resolve(m); else p.reject(new AhkhError(`ast ${m.error?.code}: ${m.error?.message}`, 'AST'));
    });
    this.child.on('exit', () => { for (const [, p] of this.pending) p.reject(new AhkhError('AstHost exited', 'AST')); this.pending.clear(); this.closed = true; });
    await this.request('ping');
    return this;
  }

  request(cmd, args = {}, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new AhkhError('AstHost not running', 'AST'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new AhkhError(`ast ${cmd} timed out`, 'TIMEOUT')); }, timeoutMs + 2000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.child.stdin.write(JSON.stringify({ id, cmd, timeoutMs, ...args }) + '\n');
    });
  }

  outline(file, { includes = false } = {}) { return this.request('outline', { path: file, includes }); }
  errors(file, { includes = false } = {}) { return this.request('errors', { path: file, includes }); }
  parse(file, { includes = false, depth } = {}) { return this.request('parse', { path: file, includes, depth }); }

  /** Run a flow (e.g. 'trace', 'minify-safe' or a path to a flow JSON) over a script; returns the transformed text. */
  async flow(file, flow, { includes = true, vars = {} } = {}) {
    let f = flow;
    if (typeof flow === 'string' && !flow.trim().startsWith('{')) {
      const dir = path.join(path.dirname(this.exe), 'flows');
      const cand = fs.existsSync(flow) ? flow : fs.readdirSync(dir).map((n) => path.join(dir, n)).find((p) => path.basename(p).replace(/^\d+-/, '').replace(/\.json$/, '') === flow || path.basename(p) === flow);
      if (!cand) throw new AhkhError(`unknown flow: ${flow}`, 'NOFLOW');
      f = fs.readFileSync(cand, 'utf8');
    }
    let text = typeof f === 'string' ? f : JSON.stringify(f);
    for (const [k, v] of Object.entries(vars)) text = text.split('${' + k + '}').join(String(v).replace(/\\/g, '\\\\\\\\'));
    return this.request('flow', { path: file, flowJson: text, includes });
  }

  async stop() { try { this.child?.stdin.end(); } catch { /* ignore */ } setTimeout(() => { try { this.child?.kill(); } catch { /* ignore */ } }, 500).unref(); }
}

export async function withAst(ctx, fn) {
  const c = await new AstClient(ctx.cfg).start();
  try { return await fn(c); } finally { await c.stop(); }
}

/** Compact, readable outline text. */
export function renderOutline(o, file) {
  const L = [];
  const pos = (n) => (n?.start ? `L${n.start.line}` : '');
  for (const f of o.functions || []) L.push(`function  ${f.name}(${(f.params || []).map((p) => (p.byref ? '&' : '') + p.name + (p.variadic ? '*' : '') + (p.optional ? '?' : '')).join(', ')})  ${pos(f)}${f.fatArrow ? ' =>' : ''}`);
  for (const c of o.classes || []) { L.push(`class     ${c.name}${c.extends ? ' extends ' + c.extends : ''}  ${pos(c)}`); for (const m of c.members || []) L.push(`  ${String(m.kind).padEnd(8)} ${m.static ? 'static ' : ''}${m.name}${m.params ? '(' + m.params.map((p) => p.name).join(', ') + ')' : ''}  ${pos(m)}`); }
  for (const h of o.hotkeys || []) L.push(`hotkey    ${h.trigger}${h.remap ? ' → ' + h.remap : ''}${h.inline ? '  (inline)' : ''}  ${pos(h)}`);
  for (const h of o.hotstrings || []) L.push(`hotstring ::${h.trigger}::${h.executes ? '(code)' : h.replacement}  ${pos(h)}`);
  for (const g of o.globals || []) L.push(`global    ${g.name}  ×${g.count}  ${pos(g)}`);
  for (const l of o.labels || []) L.push(`label     ${l.name}  ${pos(l)}`);
  for (const i of o.includes || []) L.push(`include   ${i.directive || i.path}  ${pos(i)}`);
  return L.join('\n') || '(empty)';
}
