// LSP-powered verbs: lint/diagnostics, symbols, go-to-definition, references, hover, completion, format, rename, include graph.
import path from 'node:path';
import fs from 'node:fs';
import { defineVerb, VERBS } from './registry.mjs';
import { LspClient, symbolKindName, uriToPath, pathToUri } from '../lsp/client.mjs';
import { renderText, renderSarif, renderJunit, renderGithub, diagKey, loadBaseline, saveBaseline, sevRank } from '../lsp/report.mjs';
import { buildIncludeGraph, renderIncludeTree } from '../modules/includes.mjs';
import { Run, VERDICT_EXIT } from '../evidence.mjs';
import { findAhk } from '../config.mjs';
import { expandPaths, AhkhError, truncate, writeFile, readText } from '../util.mjs';

async function getLsp(ctx, root) {
  if (ctx.lsp?.ready && !ctx.lsp.closed) return ctx.lsp;
  const c = new LspClient(ctx.cfg);
  await c.start({ rootDir: root || ctx.cfg.root });
  ctx.lsp = c;
  const prev = ctx.dispose;
  ctx.dispose = async () => { try { await c.stop(); } catch { /* ignore */ } ctx.lsp = null; if (prev) await prev(); };
  return c;
}

const COMMON = { root: { type: 'string', desc: 'workspace root for the language server (default: folder of the first file)' } };

function parsePos(ctx, a) {
  let file = a.at, line = a.line, col = a.col;
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(a.at || '');
  if (m && !/^[A-Za-z]$/.test(m[1])) { file = m[1]; line = Number(m[2]); col = Number(m[3] || 1); }
  if (!file || !line) throw new AhkhError('give a position as file:line:col', 'BADARG');
  return { file: path.resolve(ctx.cwd, file), line, col: col || 1 };
}

const sevToFinding = { error: 'error', warning: 'warn', info: 'info', hint: 'info' };

defineVerb({
  name: 'lsp.check', group: 'lint',
  desc: 'Diagnostics from the AHK v2 language server for files/folders: syntax errors, undefined/unset variables, param counts, unreachable code.',
  args: {
    paths: { type: 'array', positional: 'rest', required: true, desc: 'files, folders or globs' },
    ...COMMON,
    minSeverity: { type: 'string', default: 'warning', desc: 'error | warning | info | hint' },
    unused: { type: 'boolean', desc: 'also report unused symbols (as warnings)' },
    noUnset: { type: 'boolean', desc: 'do not warn about never-assigned variables' },
    format: { type: 'string', default: 'text', desc: 'text | json | sarif | junit | github' },
    out: { type: 'string', desc: 'write the formatted report to this file' },
    baseline: { type: 'string', desc: 'baseline file: only diagnostics NOT in it are reported/failed' },
    updateBaseline: { type: 'boolean', desc: 'write the current diagnostics to --baseline' },
    label: { type: 'string' },
  },
  async run(ctx, a) {
    const files = expandPaths(a.paths, { cwd: ctx.cwd });
    if (!files.length) throw new AhkhError('no .ahk files found', 'NOFILES');
    if (a.unused || a.noUnset) ctx.cfg.lsp = { ...ctx.cfg.lsp, settings: { ...(ctx.cfg.lsp?.settings || {}), Warn: { Unused: !!a.unused, VarUnset: !a.noUnset } } };
    const root = a.root ? path.resolve(ctx.cwd, a.root) : path.dirname(files[0]);
    const run = new Run(ctx.cfg, { label: a.label || `lsp-${files.length}files`, kind: 'lint' });
    const lsp = await getLsp(ctx, root);
    const all = []; const perFile = [];
    for (const f of files) {
      try { const r = await lsp.diagnostics(f); all.push(...r.diagnostics); perFile.push({ file: f, count: r.diagnostics.length, ms: r.ms }); }
      catch (e) { run.addFinding({ severity: 'warn', kind: 'host-error', message: `${path.basename(f)}: ${e.message}`, file: f }); }
    }
    const min = sevRank(a.minSeverity);
    let diags = all.filter((d) => sevRank(d.severity) <= min);
    let baselineHidden = 0;
    if (a.baseline) {
      const bl = path.resolve(ctx.cwd, a.baseline);
      if (a.updateBaseline) saveBaseline(bl, diags, root);
      else if (fs.existsSync(bl)) { const keys = loadBaseline(bl); const fresh = diags.filter((d) => !keys.has(diagKey(d, root))); baselineHidden = diags.length - fresh.length; diags = fresh; }
    }
    for (const d of diags) run.addFinding({ severity: sevToFinding[d.severity], kind: 'lsp-' + d.severity, message: d.message, file: d.file, line: d.line, col: d.col, code: d.code });
    const errors = diags.filter((d) => d.severity === 'error').length, warns = diags.filter((d) => d.severity === 'warning').length;
    let body;
    switch (a.format) {
      case 'json': body = JSON.stringify({ diagnostics: diags, files: perFile }, null, 2); break;
      case 'sarif': body = renderSarif(diags, { root }); break;
      case 'junit': body = renderJunit(diags, files, { root }); break;
      case 'github': body = renderGithub(diags, { root }); break;
      default: body = renderText(diags, { root });
    }
    if (a.out) writeFile(path.resolve(ctx.cwd, a.out), body);
    run.writeJson('lsp-diagnostics.json', { diagnostics: diags, files: perFile }); run.artifact('report', run.path('lsp-diagnostics.json'));
    const verdict = errors ? 'FAIL' : 'PASS';
    const summary = `${files.length} file(s): ${errors} error(s), ${warns} warning(s)${baselineHidden ? `, ${baselineHidden} baselined` : ''}${a.updateBaseline ? ' — baseline updated' : ''}`;
    const result = run.finish({ verdict, summary, data: { files: perFile } });
    const text = a.format === 'text' || !a.format ? body : (a.out ? `report written to ${a.out}` : body);
    return { verdict, summary: `${verdict}  lsp.check  ${summary}\n${text}\n  run: ${run.dir}`, data: { diagnostics: diags, files: perFile, run: result.run }, runDir: run.dir, exitCode: VERDICT_EXIT[verdict] };
  },
});

defineVerb({
  name: 'lint', group: 'lint',
  desc: 'Three-way check: AutoHotkey /Validate (ground truth, in the sandbox) vs the language server. Shows LSP false positives/negatives.',
  args: { paths: { type: 'array', positional: 'rest', required: true }, ...COMMON, minSeverity: { type: 'string', default: 'warning' } },
  async run(ctx, a) {
    const files = expandPaths(a.paths, { cwd: ctx.cwd });
    const val = await VERBS.get('validate').run(ctx, { paths: files, label: 'lint-validate' });
    const root = a.root ? path.resolve(ctx.cwd, a.root) : path.dirname(files[0]);
    const lsp = await getLsp(ctx, root); const min = sevRank(a.minSeverity);
    const rows = []; const L = [];
    for (const f of files) {
      const ahk = (val.data.findings || []).filter((x) => (x.fileChecked || x.file) && path.resolve(x.fileChecked || x.file).toLowerCase() === f.toLowerCase());
      const ahkErr = ahk.filter((x) => x.severity === 'error').length, ahkWarn = ahk.filter((x) => x.severity === 'warn').length;
      const r = await lsp.diagnostics(f);
      const d = r.diagnostics.filter((x) => sevRank(x.severity) <= min);
      const lspErr = d.filter((x) => x.severity === 'error').length, lspWarn = d.filter((x) => x.severity === 'warning').length;
      const verdict = ahkErr && lspErr ? 'both-error' : ahkErr ? 'LSP-MISSED' : lspErr ? 'LSP-ONLY (possible false positive)' : 'clean';
      rows.push({ file: f, ahk: { errors: ahkErr, warnings: ahkWarn }, lsp: { errors: lspErr, warnings: lspWarn }, agreement: verdict });
      L.push(`${verdict.padEnd(34)} AHK ${ahkErr}E/${ahkWarn}W  LSP ${lspErr}E/${lspWarn}W  ${path.relative(root, f)}`);
      if (verdict.startsWith('LSP-ONLY')) for (const x of d.filter((y) => y.severity === 'error').slice(0, 3)) L.push(`      LSP ${x.line}:${x.col} ${truncate(x.message, 100)}`);
      if (verdict === 'LSP-MISSED') for (const x of ahk.filter((y) => y.severity === 'error').slice(0, 3)) L.push(`      AHK ${x.line} ${truncate(x.message, 100)}`);
    }
    const bad = rows.filter((r) => r.agreement !== 'clean' && r.agreement !== 'both-error').length;
    const anyErr = rows.some((r) => r.ahk.errors || r.lsp.errors);
    return { verdict: anyErr ? 'FAIL' : 'PASS', summary: `${anyErr ? 'FAIL' : 'PASS'}  lint  ${files.length} file(s), ${bad} disagreement(s)\n${L.join('\n')}`, data: { rows }, exitCode: anyErr ? 1 : 0 };
  },
});

defineVerb({
  name: 'lsp.symbols', group: 'lint', desc: 'Document symbols (functions, classes, hotkeys, variables) of a file.', args: { file: { type: 'string', positional: 0, required: true }, ...COMMON },
  async run(ctx, a) {
    const f = path.resolve(ctx.cwd, a.file); const lsp = await getLsp(ctx, a.root ? path.resolve(ctx.cwd, a.root) : path.dirname(f));
    const syms = await lsp.symbols(f); const L = [];
    const rec = (list, d) => { for (const s of list || []) { L.push(`${'  '.repeat(d)}${symbolKindName(s.kind).padEnd(9)} ${s.name}  ${s.range ? `L${s.range.start.line + 1}` : (s.location ? `L${s.location.range.start.line + 1}` : '')}`); rec(s.children, d + 1); } };
    rec(syms, 0);
    return { ok: true, summary: L.join('\n') || '(none)', data: syms };
  },
});

const POS = { at: { type: 'string', positional: 0, required: true, desc: 'file:line:col (1-based)' }, ...COMMON };
const locStr = (l) => { const p = uriToPath(l.uri || l.targetUri); const r = l.range || l.targetSelectionRange || l.targetRange; let ctxLine = ''; try { ctxLine = readText(p).split(/\r?\n/)[r.start.line]?.trim().slice(0, 100) || ''; } catch { /* ignore */ } return `${p}:${r.start.line + 1}:${r.start.character + 1}  ${ctxLine}`; };

defineVerb({
  name: 'lsp.def', group: 'lint', desc: 'Go to definition (follow a symbol or #Include to where it is defined).', args: POS,
  async run(ctx, a) {
    const p = parsePos(ctx, a); const lsp = await getLsp(ctx, a.root ? path.resolve(ctx.cwd, a.root) : path.dirname(p.file));
    const r = await lsp.definition(p.file, p.line, p.col); const list = r ? (Array.isArray(r) ? r : [r]) : [];
    return { ok: list.length > 0, summary: list.map(locStr).join('\n') || 'no definition found', data: list };
  },
});

defineVerb({
  name: 'lsp.refs', group: 'lint', desc: 'Find all references to the symbol at file:line:col (who uses / calls it).', args: POS,
  async run(ctx, a) {
    const p = parsePos(ctx, a); const lsp = await getLsp(ctx, a.root ? path.resolve(ctx.cwd, a.root) : path.dirname(p.file));
    const list = (await lsp.references(p.file, p.line, p.col)) || [];
    return { ok: true, summary: `${list.length} reference(s)\n` + list.map(locStr).join('\n'), data: list };
  },
});

defineVerb({
  name: 'lsp.hover', group: 'lint', desc: 'Hover documentation/type info at file:line:col.', args: POS,
  async run(ctx, a) {
    const p = parsePos(ctx, a); const lsp = await getLsp(ctx, a.root ? path.resolve(ctx.cwd, a.root) : path.dirname(p.file));
    const r = await lsp.hover(p.file, p.line, p.col); const c = r?.contents; const text = !c ? '(nothing)' : typeof c === 'string' ? c : c.value || JSON.stringify(c);
    return { ok: !!r, summary: text, data: r };
  },
});

defineVerb({
  name: 'lsp.complete', group: 'lint', desc: 'Completion candidates at file:line:col.', args: { ...POS, limit: { type: 'number', default: 30 } },
  async run(ctx, a) {
    const p = parsePos(ctx, a); const lsp = await getLsp(ctx, a.root ? path.resolve(ctx.cwd, a.root) : path.dirname(p.file));
    const r = await lsp.completion(p.file, p.line, p.col); const items = Array.isArray(r) ? r : r?.items || [];
    return { ok: true, summary: `${items.length} item(s)\n` + items.slice(0, a.limit).map((i) => `${i.label}${i.detail ? '  — ' + truncate(i.detail, 60) : ''}`).join('\n'), data: items.slice(0, 200) };
  },
});

defineVerb({
  name: 'lsp.format', group: 'lint', desc: 'Format a file with the server. Reports whether it would change (--check); --write applies it IN PLACE (the only verb that edits originals).',
  args: { file: { type: 'string', positional: 0, required: true }, ...COMMON, check: { type: 'boolean' }, write: { type: 'boolean' }, tabSize: { type: 'number', default: 4 } },
  async run(ctx, a) {
    const f = path.resolve(ctx.cwd, a.file); const lsp = await getLsp(ctx, a.root ? path.resolve(ctx.cwd, a.root) : path.dirname(f));
    const edits = (await lsp.format(f, { tabSize: a.tabSize })) || [];
    const before = readText(f); let after = before;
    if (edits.length) after = edits[0].newText;
    const changed = after.replace(/\r\n/g, '\n') !== before.replace(/\r\n/g, '\n');
    if (a.write && changed) fs.writeFileSync(f, after.replace(/\r?\n/g, before.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
    return { ok: !changed || !!a.write, verdict: a.check && changed ? 'FAIL' : undefined, summary: changed ? (a.write ? `reformatted ${f}` : `would change ${f} (${before.split('\n').length} → ${after.split('\n').length} lines)`) : `already formatted: ${f}`, data: { changed } };
  },
});

defineVerb({
  name: 'lsp.rename', group: 'lint', desc: 'Rename the symbol at file:line:col (DRY RUN: lists the edits, changes nothing).', args: { ...POS, to: { type: 'string', required: true } },
  async run(ctx, a) {
    const p = parsePos(ctx, a); const lsp = await getLsp(ctx, a.root ? path.resolve(ctx.cwd, a.root) : path.dirname(p.file));
    const r = await lsp.rename(p.file, p.line, p.col, a.to); const ch = r?.changes || {}; const L = [];
    for (const [uri, edits] of Object.entries(ch)) for (const e of edits) L.push(`${uriToPath(uri)}:${e.range.start.line + 1}:${e.range.start.character + 1} → ${e.newText}`);
    return { ok: L.length > 0, summary: `${L.length} edit(s) (dry run)\n${L.join('\n')}`, data: r };
  },
});

defineVerb({
  name: 'lsp.stop', group: 'lint', desc: 'Stop the warm language server (hub only).', args: {},
  async run(ctx) { if (ctx.lsp) await ctx.lsp.stop(); ctx.lsp = null; return { ok: true, summary: 'language server stopped' }; },
});

defineVerb({
  name: 'includes', group: 'lint', desc: 'Static #Include graph of a script: resolved, missing, optional, cycles (no execution).',
  args: { script: { type: 'string', positional: 0, required: true } },
  async run(ctx, a) {
    const f = path.resolve(ctx.cwd, a.script); const g = buildIncludeGraph(f, { ahkExe: findAhk(ctx.cfg) });
    const ok = !g.missing.length && !g.cycles.length;
    return { verdict: ok ? 'PASS' : 'FAIL', summary: `${ok ? 'PASS' : 'FAIL'}  includes  ${g.files.length} file(s), ${g.missing.length} missing, ${g.cycles.length} cycle(s)\n${renderIncludeTree(g, path.dirname(f))}`, data: { files: g.files, missing: g.missing, cycles: g.cycles }, exitCode: ok ? 0 : 1 };
  },
});
