// Diagnostics reporters: text (terse, agent friendly), json, sarif, junit, github annotations. Plus baselines.
import path from 'node:path';
import { readJson, writeJson, signature } from '../util.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SEV_ORDER = { error: 0, warning: 1, info: 2, hint: 3 };
export const sevRank = (s) => SEV_ORDER[s] ?? 9;

/** Line-number independent key, so a baseline survives edits that only shift lines. */
export function diagKey(d, root) {
  return [path.relative(root, d.file).replace(/\\/g, '/'), d.severity, signature(d.message), String(d.sourceLine || '').trim().slice(0, 120)].join('|');
}

export function loadBaseline(file) { return new Set(readJson(file, { keys: [] }).keys || []); }
export function saveBaseline(file, diags, root) { writeJson(file, { updated: new Date().toISOString(), keys: [...new Set(diags.map((d) => diagKey(d, root)))].sort() }); }

export function renderText(diags, { root, max = 200 } = {}) {
  const byFile = new Map();
  for (const d of diags) { if (!byFile.has(d.file)) byFile.set(d.file, []); byFile.get(d.file).push(d); }
  const L = [];
  let shown = 0;
  for (const [file, list] of byFile) {
    L.push(path.relative(root || process.cwd(), file));
    for (const d of list.sort((a, b) => a.line - b.line || a.col - b.col)) {
      if (shown++ >= max) { L.push(`  … ${diags.length - max} more`); return L.join('\n'); }
      L.push(`  ${d.line}:${d.col}  ${d.severity.padEnd(7)} ${d.message}${d.code ? `  [${d.code}]` : ''}`);
      if (d.sourceLine) L.push(`        ${d.sourceLine.trim().slice(0, 140)}`);
    }
  }
  return L.join('\n');
}

export function renderSarif(diags, { root, tool = 'ahkh-lsp' } = {}) {
  const lvl = { error: 'error', warning: 'warning', info: 'note', hint: 'note' };
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
    runs: [{
      tool: { driver: { name: tool, informationUri: 'https://github.com/thqby/vscode-autohotkey2-lsp', rules: [] } },
      results: diags.map((d) => ({
        ruleId: d.code || 'ahk2', level: lvl[d.severity] || 'note', message: { text: d.message },
        locations: [{ physicalLocation: { artifactLocation: { uri: path.relative(root, d.file).replace(/\\/g, '/') }, region: { startLine: d.line, startColumn: d.col, endLine: d.endLine, endColumn: d.endCol } } }],
      })),
    }],
  }, null, 2);
}

export function renderJunit(diags, files, { root }) {
  const suites = files.map((f) => {
    const list = diags.filter((d) => d.file === f);
    const failures = list.filter((d) => d.severity === 'error').length;
    const cases = list.length ? list.map((d) => `    <testcase classname="${esc(path.relative(root, f))}" name="${esc(`${d.line}:${d.col} ${d.message}`.slice(0, 160))}">${d.severity === 'error' ? `<failure message="${esc(d.message)}">${esc(d.sourceLine || '')}</failure>` : `<system-out>${esc(d.severity + ': ' + d.message)}</system-out>`}</testcase>`).join('\n') : `    <testcase classname="${esc(path.relative(root, f))}" name="clean"/>`;
    return `  <testsuite name="${esc(path.relative(root, f))}" tests="${Math.max(1, list.length)}" failures="${failures}">\n${cases}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join('\n')}\n</testsuites>\n`;
}

export function renderGithub(diags, { root }) {
  const cmd = { error: 'error', warning: 'warning', info: 'notice', hint: 'notice' };
  return diags.map((d) => `::${cmd[d.severity] || 'notice'} file=${path.relative(root, d.file).replace(/\\/g, '/')},line=${d.line},col=${d.col}::${String(d.message).replace(/\r?\n/g, ' ')}`).join('\n');
}
