// Static #Include graph: resolved / missing / optional / cycles, with AHK's lookup rules (script dir, Lib folders, %A_ScriptDir%).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exists, readText } from '../util.mjs';
import { codeMasks } from '../overlay.mjs';

function libDirs(scriptDir, ahkExe) {
  const d = [path.join(scriptDir, 'Lib'), path.join(os.homedir(), 'Documents', 'AutoHotkey', 'Lib')];
  if (ahkExe) d.push(path.join(path.dirname(ahkExe), 'Lib'));
  return d;
}

/** Build the include tree starting at entry. Returns {root, nodes, missing, cycles}. */
export function buildIncludeGraph(entry, { ahkExe } = {}) {
  entry = path.resolve(entry);
  const scriptDir = path.dirname(entry);
  const nodes = new Map(); const missing = []; const cycles = [];
  const visit = (file, stack) => {
    const key = file.toLowerCase();
    if (nodes.has(key)) return nodes.get(key);
    const node = { file, children: [], lines: 0 };
    nodes.set(key, node);
    let text; try { text = readText(file); } catch { return node; }
    const lines = text.split(/\r?\n/); node.lines = lines.length;
    const masks = codeMasks(lines);
    let incDir = path.dirname(file);
    lines.forEach((line, i) => {
      if (!masks[i][line.search(/\S|$/)]) return;
      const m = /^\s*#Include(Again)?\s+(\*i\s+)?(.+?)\s*(?:\s;.*)?$/i.exec(line);
      if (!m) return;
      const optional = !!m[2]; let p = m[3].trim().replace(/^"|"$/g, '');
      let target = null; let libName = null;
      if (p.startsWith('<') && p.endsWith('>')) {
        libName = p.slice(1, -1);
        for (const d of libDirs(scriptDir, ahkExe)) { for (const cand of [path.join(d, libName + '.ahk'), path.join(d, libName.split('_')[0] + '.ahk')]) if (exists(cand)) { target = cand; break; } if (target) break; }
      } else {
        p = p.replace(/%A_ScriptDir%/gi, scriptDir).replace(/%A_LineFile%\\\.\./gi, path.dirname(file)).replace(/%A_WorkingDir%/gi, scriptDir).replace(/%A_AppData%/gi, process.env.APPDATA || '').replace(/%A_MyDocuments%/gi, path.join(os.homedir(), 'Documents'));
        if (/%/.test(p)) { node.children.push({ line: i + 1, spec: m[3], status: 'dynamic' }); return; }
        const abs = path.isAbsolute(p) ? p : path.resolve(incDir, p);
        if (exists(abs) && fs.statSync(abs).isDirectory()) { incDir = abs; node.children.push({ line: i + 1, spec: m[3], status: 'dir' }); return; }
        target = exists(abs) ? abs : (exists(abs + '.ahk') ? abs + '.ahk' : null);
      }
      if (!target) {
        node.children.push({ line: i + 1, spec: m[3], status: optional ? 'optional-missing' : 'missing' });
        if (!optional) missing.push({ from: file, line: i + 1, spec: m[3] });
        return;
      }
      if (stack.includes(target.toLowerCase())) { cycles.push({ from: file, to: target, line: i + 1 }); node.children.push({ line: i + 1, spec: m[3], status: 'cycle', file: target }); return; }
      const child = visit(target, [...stack, target.toLowerCase()]);
      node.children.push({ line: i + 1, spec: m[3], status: 'ok', file: target, node: child, optional });
    });
    return node;
  };
  const root = visit(entry, [entry.toLowerCase()]);
  return { root, files: [...nodes.values()].map((n) => n.file), missing, cycles };
}

export function renderIncludeTree(graph, base = process.cwd()) {
  const L = []; const seen = new Set();
  const rel = (f) => path.relative(base, f) || f;
  const rec = (node, depth) => {
    for (const c of node.children) {
      const pad = '  '.repeat(depth);
      if (c.status === 'ok') { const again = seen.has(c.file.toLowerCase()); L.push(`${pad}✓ ${rel(c.file)} (line ${c.line})${again ? ' [already shown]' : ''}`); if (!again) { seen.add(c.file.toLowerCase()); rec(c.node, depth + 1); } }
      else if (c.status === 'dir') L.push(`${pad}· dir ${c.spec}`);
      else if (c.status === 'dynamic') L.push(`${pad}? ${c.spec} (dynamic path, not resolved)`);
      else L.push(`${pad}✗ ${c.spec} — ${c.status} (line ${c.line})`);
    }
  };
  L.push(rel(graph.root.file)); seen.add(graph.root.file.toLowerCase()); rec(graph.root, 1);
  return L.join('\n');
}
