// Overlay / patch engine. Originals are NEVER modified: patches are applied to a shadow copy under the run folder, and a line map
// lets errors reported against the patched script be mapped back to the original lines.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir, exists, readJson, readText, globToRegExp, walk, AhkhError, HARNESS_ROOT, writeFile } from './util.mjs';
import { ProbeClient } from './probe.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.ahkh', 'runs', '.vs', '.vscode', '__pycache__']);

// ---------------------------------------------------------------------- recipes

/** Resolve --patch items: recipe name (patches/<name>.json), a file path, or an inline JSON op/recipe. */
export function loadRecipes(cfg, items = []) {
  const ops = []; const names = [];
  for (const it of items) {
    let rec = null;
    if (typeof it === 'object' && it) rec = it;
    else if (typeof it === 'string' && it.trim().startsWith('{')) rec = JSON.parse(it);
    else if (typeof it === 'string' && it.trim().startsWith('[')) rec = { ops: JSON.parse(it) };
    else {
      const cands = [it, path.join(cfg.root, 'patches', it + '.json'), path.join(cfg.root, 'patches', it), path.join(HARNESS_ROOT, 'patches', it + '.json'), path.join(HARNESS_ROOT, 'patches', it)];
      const f = cands.find((c) => exists(c) && fs.statSync(c).isFile());
      if (!f) throw new AhkhError(`patch recipe not found: ${it} (looked in patches/ and as a path)`, 'NOPATCH');
      rec = readJson(f, null);
      if (!rec) throw new AhkhError(`patch recipe is not valid JSON: ${f}`, 'NOPATCH');
    }
    if (Array.isArray(rec)) rec = { ops: rec };
    if (!rec.ops) rec = { ops: [rec] };
    names.push(rec.name || 'inline');
    for (const op of rec.ops) ops.push({ ...op, recipe: rec.name || 'inline' });
  }
  return { ops, names };
}

// ---------------------------------------------------------------------- code masking (don't patch strings/comments)

/** Returns per-line boolean arrays: true where the char is executable code (not string/comment/continuation-section). */
export function codeMasks(lines) {
  const masks = []; let inBlock = false; let inCont = false;
  for (const line of lines) {
    const m = new Array(line.length).fill(false);
    const t = line.trimStart();
    if (inBlock) { if (/\*\/\s*$/.test(line)) inBlock = false; masks.push(m); continue; }
    if (inCont) { if (t.startsWith(')')) inCont = false; masks.push(m); continue; }
    if (t.startsWith('/*')) { if (!/\*\/\s*$/.test(line)) inBlock = true; masks.push(m); continue; }
    if (t.startsWith('(') && !/\)/.test(t.slice(1)) && !/^\(.*\)\s*(=>|\{)/.test(t)) { inCont = true; masks.push(m); continue; }
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '`') { i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === ';' && (i === 0 || /\s/.test(line[i - 1]))) break;
      m[i] = true;
    }
    masks.push(m);
  }
  return masks;
}

// ---------------------------------------------------------------------- overlay files

class OFile {
  constructor(abs, orig, text) {
    this.abs = abs; this.orig = orig;
    this.eol = /\r\n/.test(text) ? '\r\n' : '\n';
    this.bom = text.charCodeAt(0) === 0xFEFF; if (this.bom) text = text.slice(1);
    this.lines = text.split(/\r?\n/);
    this.map = this.lines.map((_, i) => i + 1);      // new line index -> original line (null = injected)
    this.dirty = false;
  }
  text() { return (this.bom ? '﻿' : '') + this.lines.join(this.eol); }
  insert(at, newLines) { this.lines.splice(at, 0, ...newLines); this.map.splice(at, 0, ...newLines.map(() => null)); this.dirty = true; }
  remove(at, n = 1) { this.lines.splice(at, n); this.map.splice(at, n); this.dirty = true; }
}

function copyTree(src, dst, { maxFiles = 6000, maxBytes = 250 * 1024 * 1024 } = {}) {
  let files = 0, bytes = 0;
  const rec = (s, d) => {
    ensureDir(d);
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) rec(sp, dp);
      else if (e.isFile()) {
        const st = fs.statSync(sp); files++; bytes += st.size;
        if (files > maxFiles || bytes > maxBytes) throw new AhkhError(`script folder too large to shadow-copy (${files} files, ${(bytes / 1048576).toFixed(0)} MB). Point the harness at a smaller folder or run without patches.`, 'TOOBIG');
        try { fs.copyFileSync(sp, dp); } catch { /* locked file: skip */ }
      }
    }
  };
  rec(src, dst);
  return { files, bytes };
}

const isAhk = (p) => /\.ahk2?$/i.test(p);

// ---------------------------------------------------------------------- ops

function selectFiles(state, spec) {
  const all = [...state.files.values()];
  if (!spec || spec === '*' || spec === 'all') return all.filter((f) => isAhk(f.abs));
  if (spec === 'entry') return [state.files.get(state.entryAbs)];
  const rx = globToRegExp(spec.replace(/\\/g, '/'));
  return all.filter((f) => rx.test(path.relative(state.dir, f.abs).replace(/\\/g, '/')) || rx.test(path.basename(f.abs)));
}

function toRegExp(op) {
  if (op.regex) return new RegExp(op.regex, (op.flags || '') + (op.flags?.includes('g') ? '' : 'g'));
  const esc = String(op.find ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc, 'g');
}

function opReplace(state, op, log) {
  const rx = toRegExp(op); let n = 0;
  for (const f of selectFiles(state, op.file)) {
    const masks = op.code === false ? null : codeMasks(f.lines);
    for (let i = 0; i < f.lines.length; i++) {
      if (op.line && op.line !== f.map[i]) continue;
      const line = f.lines[i];
      const out = line.replace(rx, (...m) => {
        const hasGroups = typeof m[m.length - 1] === 'object';
        const off = m[m.length - (hasGroups ? 3 : 2)];              // offset of the match within the line
        if (masks && !masks[i][off]) return m[0];
        if (op.count && n >= op.count) return m[0];
        n++;
        return String(op.with ?? '').replace(/\$(\d)/g, (_, d) => (typeof m[Number(d)] === 'string' ? m[Number(d)] : ''));
      });
      if (out !== line) { f.lines[i] = out; f.dirty = true; }
    }
  }
  log.push(`replace: ${n} change(s) [${op.recipe}]`);
}

/** Where directives go: right after the first #Requires (if any, within the first 40 lines), else the very top. */
function opInsertPos(f, op, where) {
  if (where !== 'top') return f.lines.length;
  const rq = f.lines.findIndex((l, k) => k < 40 && /^\s*#Requires\b/i.test(l));
  return rq >= 0 ? rq + 1 : 0;
}

function applyOps(state, ops, log) {
  for (const op of ops) {
    const kind = op.op || op.type;
    switch (kind) {
      case 'replace': opReplace(state, op, log); break;
      case 'prepend': for (const f of selectFiles(state, op.file || 'entry')) { f.insert(opInsertPos(f, op, 'top'), String(op.text).split(/\r?\n/)); log.push(`prepend into ${path.basename(f.abs)} [${op.recipe}]`); } break;
      case 'append': for (const f of selectFiles(state, op.file || 'entry')) { f.insert(f.lines.length, String(op.text).split(/\r?\n/)); log.push(`append to ${path.basename(f.abs)} [${op.recipe}]`); } break;
      case 'insertAfter': case 'insertBefore': {
        const rx = new RegExp(op.match, op.flags || ''); let n = 0;
        for (const f of selectFiles(state, op.file)) {
          for (let i = 0; i < f.lines.length; i++) {
            if (rx.test(f.lines[i])) { f.insert(kind === 'insertAfter' ? i + 1 : i, String(op.text).split(/\r?\n/)); i += String(op.text).split(/\r?\n/).length; n++; if (op.once) break; }
          }
        }
        log.push(`${kind}: ${n} place(s) [${op.recipe}]`); break;
      }
      case 'delete': {
        const rx = new RegExp(op.match, op.flags || ''); let n = 0;
        for (const f of selectFiles(state, op.file)) for (let i = f.lines.length - 1; i >= 0; i--) if (rx.test(f.lines[i])) { f.remove(i); n++; }
        log.push(`delete: ${n} line(s) [${op.recipe}]`); break;
      }
      case 'include': for (const f of selectFiles(state, op.file || 'entry')) { f.insert(opInsertPos(f, op, 'top'), [`#Include "${op.path}"`]); log.push(`include ${op.path} [${op.recipe}]`); } break;
      case 'stub': opStub(state, op, log); break;
      default: throw new AhkhError(`unknown patch op: ${kind}`, 'BADPATCH');
    }
  }
}

/** Rewrite calls to listed functions into calls to generated Ahkh_Stub_<Name> functions (logged, harmless). */
function opStub(state, op, log) {
  const calls = Array.isArray(op.calls) ? op.calls : [op.name].filter(Boolean);
  const defs = [];
  let total = 0;
  for (const name of calls) {
    const stubName = 'Ahkh_Stub_' + name;
    const paren = new RegExp(`(?<![\\w.%$])${name}(?=\\s*\\()`, 'g');
    const stmt = new RegExp(`^(\\s*)${name}(?=[ \\t]+[^\\s:=(.,\\[])`);
    for (const f of selectFiles(state, op.file)) {
      if (f.abs === state.stubFile) continue;
      const masks = codeMasks(f.lines);
      for (let i = 0; i < f.lines.length; i++) {
        let line = f.lines[i]; const before = line;
        line = line.replace(paren, (m, off) => (masks[i][off] ? (total++, stubName) : m));
        if (stmt.test(line) && masks[i][line.search(/\S/)]) { line = line.replace(stmt, `$1${stubName}`); total++; }
        if (line !== before) { f.lines[i] = line; f.dirty = true; }
      }
    }
    const ret = op.returns === undefined ? '""' : String(op.returns);
    const body = op.body || `return ${ret}`;
    const NL = '\n';
    const logLine = op.quiet ? '' : `try FileAppend('AHKH|log|{"msg":"stub ${name}"}\`n', "*", "UTF-8")${NL}    `;
    defs.push(`${stubName}(${op.params || 'params*'}) {${NL}    ${logLine}${body.split(NL).join(NL + '    ')}${NL}}`);
  }
  state.stubDefs.push(...defs);
  log.push(`stub ${calls.join(',')}: ${total} call site(s) rewritten [${op.recipe}]`);
}

// ---------------------------------------------------------------------- include relocation

/** Relative #Include paths that resolve OUTSIDE the copied folder are rewritten to absolute paths of the originals. */
function relocateIncludes(state, srcDir, log) {
  let n = 0;
  for (const f of state.files.values()) {
    if (!isAhk(f.abs)) continue;
    const origDir = path.dirname(f.orig);
    const masks = codeMasks(f.lines);
    for (let i = 0; i < f.lines.length; i++) {
      if (!masks[i][f.lines[i].search(/\S|$/)]) continue;
      const m = /^(\s*#Include(?:Again)?\s+)(\*i\s+)?(.+?)(\s*(?:;.*)?)$/i.exec(f.lines[i]);
      if (!m) continue;
      let p = m[3].trim().replace(/^"|"$/g, '');
      if (p.startsWith('<')) continue;
      let abs;
      if (/^%A_ScriptDir%/i.test(p)) abs = path.resolve(srcDir, p.replace(/^%A_ScriptDir%[\\/]?/i, ''));
      else if (/%/.test(p)) continue;
      else if (path.isAbsolute(p)) continue;
      else abs = path.resolve(origDir, p);
      const rel = path.relative(srcDir, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) continue;   // stays inside the copy
      f.lines[i] = `${m[1]}${m[2] || ''}${abs}${m[4]}`; f.dirty = true; n++;
    }
  }
  if (n) log.push(`relocated ${n} out-of-tree #Include(s) to absolute paths`);
}

// ---------------------------------------------------------------------- build

export function buildOverlay({ cfg, run, script, ops, names = [] }) {
  const srcDir = path.dirname(script);
  const dir = ensureDir(run.path('overlay'));
  const stats = copyTree(srcDir, dir);
  const state = { dir, files: new Map(), entryAbs: path.join(dir, path.basename(script)), stubDefs: [], stubFile: path.join(dir, '__ahkh_stubs.ahk') };
  for (const p of walk(dir, { filter: isAhk, skip: [] })) {
    const orig = path.join(srcDir, path.relative(dir, p));
    state.files.set(p, new OFile(p, orig, fs.readFileSync(p, 'utf8')));
  }
  if (!state.files.has(state.entryAbs)) throw new AhkhError('entry script missing from overlay copy', 'NOOVERLAY');
  const log = [];
  applyOps(state, ops, log);
  relocateIncludes(state, srcDir, log);
  const linemap = {}; const changed = [];
  for (const f of state.files.values()) {
    if (!f.dirty) continue;
    fs.writeFileSync(f.abs, f.text(), 'utf8');
    linemap[f.abs] = { orig: f.orig, lines: f.map };
    changed.push(f);
  }
  const includes = [];
  if (state.stubDefs.length) {
    writeFile(state.stubFile, '#Requires AutoHotkey v2.0\n; generated by ahkh: harmless stand-ins for stubbed calls\n' + state.stubDefs.join('\n') + '\n');
    includes.push(state.stubFile);
  }
  let diff = '';
  for (const f of changed) {
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--unified=2', f.orig, f.abs], { encoding: 'utf8', windowsHide: true });
    diff += (r.stdout || '') + '\n';
  }
  return { dir, entry: state.entryAbs, cwd: dir, linemap, includes, log, diff: diff.trim(), stats, changed: changed.map((f) => f.abs), names };
}

/** Save patched files + diff as evidence and drop the (potentially large) shadow copy. */
function archiveOverlay(run, built) {
  try {
    for (const f of built.changed) {
      const rel = path.relative(built.dir, f);
      ensureDir(path.dirname(run.path('effective', rel)));
      fs.copyFileSync(f, run.path('effective', rel)); run.artifact('effective', run.path('effective', rel));
    }
    if (built.diff) { run.write('effective/patch.diff', built.diff + '\n'); run.artifact('diff', run.path('effective/patch.diff')); }
    run.writeJson('effective/linemap.json', built.linemap);
    fs.rmSync(built.dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------- entry point used by run/session/smoke

/**
 * probe: false | 'passive' | 'rpc'
 * overlay: 'auto' (only when patches are given) | 'always' | 'never'
 */
export async function prepareTarget(ctx, session, script, { patch = [], probe = false, overlay = 'auto', onError } = {}) {
  const cfg = ctx.cfg; const run = session.run;
  const prepared = { entry: script, cwd: path.dirname(script), includes: [], env: {}, linemap: null, cleanup: async () => {}, after: null, overlaid: false };
  const { ops, names } = loadRecipes(cfg, patch || []);
  if (ops.length || overlay === 'always') {
    const built = buildOverlay({ cfg, run, script, ops, names });
    Object.assign(prepared, { entry: built.entry, cwd: built.cwd, linemap: Object.keys(built.linemap).length ? built.linemap : null, overlaid: true, built });
    prepared.includes.push(...built.includes);
    run.meta.patches = names; run.meta.overlay = { files: built.stats.files, patched: built.changed.map((f) => path.relative(built.dir, f)), log: built.log };
    run.event('overlay.built', { patched: built.changed.length, log: built.log });
    prepared.cleanup = async () => archiveOverlay(run, built);
  }
  if (probe) {
    const pdir = ensureDir(run.path('probe'));
    prepared.includes.push(path.join(HARNESS_ROOT, 'ahk', 'AhkProbe.ahk'));
    prepared.env.AHKH_PROBE_DIR = pdir;
    prepared.env.AHKH_PROBE_MODE = probe === 'rpc' ? 'rpc' : 'passive';
    if (onError) prepared.env.AHKH_ONERROR = onError;
    session.probe = new ProbeClient(session, pdir);
    run.meta.probe = prepared.env.AHKH_PROBE_MODE;
  }
  // AutoHotkey honours exactly ONE /include switch (a second one makes it exit with code 2 and no message), so merge them.
  if (prepared.includes.length > 1) {
    const prelude = run.path('prelude.ahk');
    writeFile(prelude, '#Requires AutoHotkey v2.0\n; generated by ahkh: everything injected ahead of the target script\n' + prepared.includes.map((p) => `#Include "${p}"`).join('\n') + '\n');
    prepared.includes = [prelude];
  }
  session.prepared = prepared;
  return prepared;
}
