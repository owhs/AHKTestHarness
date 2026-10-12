// Project configuration: ahkh.json discovery + defaults + tool location (AutoHotkey, node, LSP extension).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HARNESS_ROOT, exists, readJson, readText } from './util.mjs';

export const DEFAULTS = {
  outDir: null,                 // resolved to <projectRoot>/.ahkh/runs unless set
  keepRuns: 60,                 // retention: prune older run folders beyond this many
  ahk: { exe: null, args: [] }, // null => auto-detect
  timeoutMs: 20000,
  shots: { onDialog: true, onWindow: false, everyMs: 0, maxEdge: 1400, technique: 'auto' },
  rules: [],                    // extra dialog rules, matched before the built-ins
  keepGoing: false,             // AHK error dialog: press Continue instead of killing the script
  failOnDialog: false,          // treat plain MsgBox dialogs as a failure
  lsp: { extension: null, node: null, warm: false, settings: {} },
  ast: { host: null },
  probe: { inject: 'auto' },
  guard: true,
};

export function findProjectFile(startDir) {
  let d = path.resolve(startDir);
  for (;;) {
    const p = path.join(d, 'ahkh.json');
    if (exists(p)) return p;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function merge(a, b) {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b === undefined ? a : b;
  const o = { ...a };
  for (const k of Object.keys(b)) o[k] = merge(a[k], b[k]);
  return o;
}

export function loadConfig({ cwd = process.cwd(), project = null, overrides = {} } = {}) {
  const file = project ? path.resolve(project) : findProjectFile(cwd);
  const user = file ? readJson(file, {}) : {};
  const root = file ? path.dirname(file) : path.resolve(cwd);
  let cfg = merge(DEFAULTS, user);
  cfg = merge(cfg, overrides);
  cfg.projectFile = file;
  cfg.root = root;
  cfg.outDir = path.resolve(root, cfg.outDir || path.join('.ahkh', 'runs'));
  cfg.harnessRoot = HARNESS_ROOT;
  cfg.hostExe = process.env.AHKH_HOST_EXE || path.join(HARNESS_ROOT, 'bin', 'ahkh-host.exe');   // override: test a new host build while bin\ is in use
  return cfg;
}

const AHK_CANDIDATES = [
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey.exe',
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey32.exe',
  'C:\\Program Files\\AutoHotkey\\AutoHotkey64.exe',
  'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey.exe',
];

/** Pick an AutoHotkey exe. requires = text of a `#Requires AutoHotkey ...` line (optional). */
export function findAhk(cfg, { requires = '', bits = null } = {}) {
  if (cfg.ahk?.exe && exists(cfg.ahk.exe)) return cfg.ahk.exe;
  if (process.env.AHKH_AHK && exists(process.env.AHKH_AHK)) return process.env.AHKH_AHK;
  const want32 = bits === 32 || /32-bit/i.test(requires);
  const list = want32 ? AHK_CANDIDATES.filter((p) => /32|x86/.test(p)).concat(AHK_CANDIDATES) : AHK_CANDIDATES;
  for (const p of list) if (exists(p)) return p;
  for (const dir of (process.env.PATH || '').split(';')) {
    for (const n of ['AutoHotkey64.exe', 'AutoHotkey.exe']) { const p = path.join(dir, n); if (dir && exists(p)) return p; }
  }
  return null;
}

/** Newest thqby.vscode-autohotkey2-lsp extension folder (numeric version sort; the AxLsp sort bug fixed). */
export function findLspExtension(cfg) {
  if (cfg.lsp?.extension && exists(path.join(cfg.lsp.extension, 'server', 'dist', 'server.js'))) return cfg.lsp.extension;
  if (process.env.AHKH_LSP && exists(path.join(process.env.AHKH_LSP, 'server', 'dist', 'server.js'))) return process.env.AHKH_LSP;
  const roots = [path.join(os.homedir(), '.vscode', 'extensions'), path.join(os.homedir(), '.vscode-insiders', 'extensions'), path.join(HARNESS_ROOT, 'vendor', 'lsp')];
  const found = [];
  for (const r of roots) {
    let ents; try { ents = fs.readdirSync(r); } catch { continue; }
    for (const e of ents) if (/^thqby\.vscode-autohotkey2-lsp/i.test(e) || (r.endsWith('lsp') && e)) {
      const p = path.join(r, e); if (exists(path.join(p, 'server', 'dist', 'server.js'))) found.push(p);
    }
  }
  const ver = (p) => (path.basename(p).match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  found.sort((a, b) => { const va = ver(a), vb = ver(b); for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i]; return 0; });
  return found[0] || null;
}

export function findNode(cfg) {
  if (cfg.lsp?.node && exists(cfg.lsp.node)) return cfg.lsp.node;
  if (!globalThis.Bun && process.execPath && /node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  for (const dir of (process.env.PATH || '').split(';')) { const p = path.join(dir, 'node.exe'); if (dir && exists(p)) return p; }
  const pf = 'C:\\Program Files\\nodejs\\node.exe';
  return exists(pf) ? pf : null;
}

export function findAstHost(cfg) {
  const c = [cfg.ast?.host, path.join(HARNESS_ROOT, 'vendor', 'ast', 'AstHost.exe')].filter(Boolean);
  for (const p of c) if (exists(p)) return p;
  return null;
}

/** First `#Requires AutoHotkey ...` line of a script, or ''. */
export function readRequires(file) {
  try {
    const head = readText(file).split(/\r?\n/, 80);
    for (const l of head) { const m = /^\s*#Requires\s+(AutoHotkey.*)$/i.exec(l); if (m) return m[1]; }
  } catch { /* ignore */ }
  return '';
}
