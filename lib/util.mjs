// Small shared helpers. Zero dependencies; works on node >= 18 and bun.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isBun = typeof globalThis.Bun !== 'undefined';
export const runtimeName = isBun ? `bun ${globalThis.Bun.version}` : `node ${process.versions.node}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
export const t0 = performance.now();
export const elapsed = () => Math.round(performance.now() - t0);

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
export function writeFile(p, data) { ensureDir(path.dirname(p)); fs.writeFileSync(p, data); return p; }
export function writeJson(p, obj) { return writeFile(p, JSON.stringify(obj, null, 2)); }
export function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}
export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
export function readText(p) { return fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); }

export function slug(s, max = 48) {
  return String(s ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'x';
}

export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function shortId(n = 4) { return crypto.randomBytes(n).toString('hex'); }
export function sha1(data) { return crypto.createHash('sha1').update(data).digest('hex'); }
export function sha1File(p) { try { return sha1(fs.readFileSync(p)); } catch { return null; } }

/** Grouping key for findings: strip paths/numbers so the same bug on different lines/files collapses. */
export function signature(msg) {
  return String(msg ?? '')
    .replace(/[A-Za-z]:[\\/][^\s"')\]]+/g, '<path>')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '<hex>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** Windows-quote one argument for a CreateProcess command line. */
export function quoteArg(a) {
  a = String(a);
  if (a !== '' && !/[\s"]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
export const joinArgs = (arr) => arr.map(quoteArg).join(' ');

export function truncate(s, n = 400) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `… (+${s.length - n})` : s; }

export function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms'; }

/** Promise that resolves when pred() is truthy, polling; rejects with Error(message) on timeout. */
export async function pollUntil(pred, { timeout = 10000, interval = 40, message = 'timed out' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) { const e = new Error(message); e.code = 'TIMEOUT'; throw e; }
    await sleep(interval);
  }
}

/** Recursively list files under dir matching a predicate. Skips junk directories. */
export function walk(dir, { filter = () => true, skip = ['.git', 'node_modules', '.ahkh', 'runs'], max = 20000 } = {}) {
  const out = [];
  const rec = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.includes(e.name)) rec(p); }
      else if (filter(p)) out.push(p);
    }
  };
  rec(dir);
  return out;
}

/** Minimal glob: supports *, **, ? and comma-free patterns. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/' || glob[i + 1] === '\\') i++; } else re += '[^/\\\\]*'; }
    else if (c === '?') re += '[^/\\\\]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

/** Expand files/dirs/globs into a list of absolute file paths. */
export function expandPaths(inputs, { ext = ['.ahk'], cwd = process.cwd() } = {}) {
  const out = new Set();
  for (const raw of inputs) {
    const p = path.resolve(cwd, raw);
    if (/[*?]/.test(raw)) {
      const base = path.resolve(cwd, raw.split(/[\\/]/).filter((s, i, a) => !/[*?]/.test(a.slice(0, i + 1).join('/'))).join('/') || '.');
      const rx = globToRegExp(path.resolve(cwd, raw).replace(/\\/g, '/'));
      for (const f of walk(base)) if (rx.test(f.replace(/\\/g, '/'))) out.add(f);
    } else if (exists(p) && fs.statSync(p).isDirectory()) {
      for (const f of walk(p, { filter: (f) => ext.includes(path.extname(f).toLowerCase()) })) out.add(f);
    } else if (exists(p)) out.add(p);
    else throw new Error(`path not found: ${raw}`);
  }
  return [...out];
}

/** Very small JSON-lines splitter for stream chunks. */
export class LineSplitter {
  constructor(onLine) { this.buf = ''; this.onLine = onLine; }
  push(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }
}

export class AhkhError extends Error {
  constructor(message, code = 'ERROR', extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}
