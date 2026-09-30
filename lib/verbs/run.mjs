// core verbs: run, validate, doctor
import path from 'node:path';
import fs from 'node:fs';
import { defineVerb } from './registry.mjs';
import { Session } from '../session.mjs';
import { resolveAhk, ahkArgs, assertScript, harvestAhkText, harvestProbeErrors, scriptNameOf } from '../adapters/ahk2.mjs';
import { prepareTarget } from '../overlay.mjs';
import { findAhk, findNode, findLspExtension, findAstHost } from '../config.mjs';
import { VERDICT_EXIT } from '../evidence.mjs';
import { sleep, exists, readJson, runtimeName, truncate, fmtMs, AhkhError, expandPaths } from '../util.mjs';

/** Compact, agent-friendly rendering of a finished run. */
export function formatRun(result, { max = 8 } = {}) {
  const L = [`${result.verdict}  ${result.label}  (${fmtMs(result.durationMs)})  ${result.summary || ''}`.trim()];
  const errs = result.findings.filter((f) => f.severity !== 'info');
  const seen = new Set();
  for (const f of errs) {
    const key = f.signature; if (seen.has(key)) continue; seen.add(key);
    if (seen.size > max) { L.push(`  … +${errs.length - max} more (see summary.md)`); break; }
    L.push(`  ${f.severity === 'error' ? '✗' : '!'} ${f.kind}: ${truncate(String(f.message).replace(/\s+/g, ' '), 220)}${f.file ? `  [${path.basename(f.file)}${f.line ? ':' + f.line : ''}]` : ''}`);
  }
  const shots = result.artifacts.filter((a) => a.kind === 'shot' || a.kind === 'sheet');
  if (shots.length) L.push(`  shots: ${shots.length}  (${shots.slice(-3).map((s) => s.rel).join(', ')})`);
  L.push(`  run: ${result.runDir || result.run}`);
  return L.join('\n');
}

defineVerb({
  name: 'run', group: 'core',
  desc: 'Run an AutoHotkey v2 script on the hidden desktop; catch dialogs, errors, crashes; screenshot; report a verdict.',
  args: {
    script: { type: 'string', positional: 0, required: true, desc: 'path to the .ahk script' },
    for: { type: 'number', alias: 'f', desc: 'observe a long-running script for N seconds then stop it (expected-to-keep-running mode)' },
    timeout: { type: 'number', alias: 't', desc: 'hard timeout in seconds for scripts expected to exit (default from config, 20)' },
    args: { type: 'array', desc: 'arguments passed to the script (comma separated, or repeat)' },
    label: { type: 'string', desc: 'run label (folder name)' },
    keepGoing: { type: 'boolean', desc: 'AHK error dialogs: press Continue instead of killing the script' },
    shotsEvery: { type: 'number', desc: 'auto desktop screenshot every N ms' },
    shotsOnWindow: { type: 'boolean', desc: 'screenshot every window that appears' },
    noFinalShot: { type: 'boolean', desc: 'skip the final desktop screenshot' },
    env: { type: 'json', desc: 'extra environment variables as JSON object' },
    rules: { type: 'json', desc: 'extra dialog rules (JSON array) matched before the defaults' },
    patch: { type: 'array', desc: 'patch recipes to apply on a shadow copy (names from patches/ or file paths)' },
    probe: { type: 'boolean', desc: 'inject the in-process AhkProbe (chained OnError + AHKH| test protocol) via /include, without editing the script' },
    probeOnError: { type: 'string', desc: 'with --probe: log | exit | continue' },
    bits: { type: 'number', desc: '32 or 64: pick the 32-bit AutoHotkey' },
  },
  async run(ctx, a) {
    const script = assertScript(path.resolve(ctx.cwd, a.script));
    const { exe } = resolveAhk(ctx.cfg, script, { bits: a.bits });
    const s = await Session.open(ctx, {
      label: a.label || path.basename(script, path.extname(script)), kind: 'run', keepGoing: a.keepGoing, rules: a.rules || [],
      shots: { everyMs: a.shotsEvery || 0, onWindow: !!a.shotsOnWindow }, meta: { script, ahk: exe, args: a.args || [] },
    });
    let prepared = null;
    try {
      prepared = await prepareTarget(ctx, s, script, { patch: a.patch, probe: a.probe ? 'passive' : false, onError: a.probeOnError });
      const observe = a.for != null;
      const timeoutMs = Math.round((a.timeout ?? ctx.cfg.timeoutMs / 1000) * 1000);
      await s.launch({
        name: 'main', exe, cwd: prepared.cwd, scriptName: scriptNameOf(script), expect: observe ? 'running' : 'exit', timeoutMs,
        args: ahkArgs({ script: prepared.entry, scriptArgs: a.args || [], includes: prepared.includes || [] }), env: { ...(prepared.env || {}), ...(a.env || {}) },
      });
      const p = s.proc('main');
      await s.waitExit('main', observe ? a.for * 1000 : timeoutMs + 6000, { soft: true });
      if (!p.exited) {
        if (!a.noFinalShot) { try { await s.snapshot('final'); await s.shot({ desktop: true, label: 'final' }); } catch { /* no window yet */ } }
        await s.kill('main', 'end-of-observation');
      }
      harvestAhkText(s, 'main', { linemap: prepared.linemap });
      harvestProbeErrors(s, 'main');
      if (prepared.after) await prepared.after(s);
    } catch (e) {
      s.addFinding({ severity: 'error', kind: 'host-error', message: e.message });
    }
    if (prepared?.cleanup) { try { await prepared.cleanup(); } catch { /* best effort */ } }
    const result = await s.close({});
    result.runDir = s.dir;
    return { verdict: result.verdict, summary: formatRun(result), data: result, runDir: s.dir, exitCode: VERDICT_EXIT[result.verdict] ?? 1, images: [] };
  },
});

defineVerb({
  name: 'validate', group: 'core',
  desc: 'AutoHotkey /Validate one or more scripts (loads without running) inside the sandbox; returns load errors/warnings.',
  args: {
    paths: { type: 'array', positional: 'rest', required: true, desc: 'files, folders or globs' },
    timeout: { type: 'number', desc: 'per-file timeout seconds (default 20)' },
    label: { type: 'string', desc: 'run label' },
  },
  async run(ctx, a) {
    const files = expandPaths(a.paths, { cwd: ctx.cwd });
    if (!files.length) throw new AhkhError('no .ahk files found', 'NOFILES');
    const s = await Session.open(ctx, { label: a.label || `validate-${files.length}`, kind: 'validate', shots: { onDialog: true } });
    const per = [];
    try {
      for (const f of files) {
        const { exe } = resolveAhk(ctx.cfg, f);
        const name = 'v' + (per.length + 1);
        await s.launch({ name, exe, cwd: path.dirname(f), scriptName: path.basename(f), expect: 'exit', timeoutMs: (a.timeout ?? 20) * 1000, args: ahkArgs({ script: f, validate: true }) });
        await s.waitExit(name, (a.timeout ?? 20) * 1000 + 5000, { soft: true });
        const p = s.proc(name);
        const before = s.run.findings.length;
        harvestAhkText(s, name);
        const mine = s.run.findings.slice(before);
        for (const fi of mine) fi.fileChecked = f;
        per.push({ file: f, exit: p.exitCode, errors: mine.filter((x) => x.severity === 'error').length, warnings: mine.filter((x) => x.severity === 'warn').length });
        if (p.exitCode && p.exitCode !== 0 && !mine.length && !p.crashed) s.addFinding({ severity: 'error', kind: 'load-error', proc: name, file: f, message: `AutoHotkey exited ${p.exitCode} without a parsable message: ${truncate((p.out.concat(p.err)).join(' | '), 200)}` });
      }
    } catch (e) { s.addFinding({ severity: 'error', kind: 'host-error', message: e.message }); }
    const bad = per.filter((x) => x.errors || x.exit);
    const result = await s.close({ summary: `${files.length} file(s): ${per.length - bad.length} ok, ${bad.length} with errors` });
    const lines = [`${result.verdict}  validate  ${result.summary}`];
    for (const f of result.findings.filter((x) => x.severity !== 'info').slice(0, 20)) lines.push(`  ${f.severity === 'error' ? '✗' : '!'} ${path.basename(f.file || '')}${f.line ? ':' + f.line : ''}  ${truncate(f.message, 200)}`);
    lines.push(`  run: ${s.dir}`);
    return { verdict: result.verdict, summary: lines.join('\n'), data: { files: per, findings: result.findings }, runDir: s.dir, exitCode: VERDICT_EXIT[result.verdict] ?? 1 };
  },
});

defineVerb({
  name: 'doctor', group: 'core', desc: 'Check the environment: host build, AutoHotkey, node/bun, LSP extension, AST host.',
  args: {},
  async run(ctx) {
    const c = ctx.cfg; const rows = [];
    const add = (name, ok, detail) => rows.push({ name, ok, detail });
    add('runtime', true, runtimeName);
    add('native host', exists(c.hostExe), c.hostExe + (exists(c.hostExe) ? '' : '  (run build.ps1)'));
    const ahk = findAhk(c); add('AutoHotkey v2', !!ahk, ahk || 'not found (set ahk.exe in ahkh.json / AHKH_AHK)');
    const node = findNode(c); add('node (for LSP)', !!node, node || 'not found');
    const lsp = findLspExtension(c); add('LSP extension', !!lsp, lsp || 'thqby.vscode-autohotkey2-lsp not found (install in VS Code, or set lsp.extension)');
    const ast = findAstHost(c); add('AST host', !!ast, ast || 'optional: vendor/ast/AstHost.exe');
    add('project', true, c.projectFile || '(none — using cwd)');
    add('output dir', true, c.outDir);
    const bad = rows.filter((r) => !r.ok && !/AST/.test(r.name));
    return { verdict: bad.length ? 'FAIL' : 'PASS', summary: rows.map((r) => `${r.ok ? '✓' : '✗'} ${r.name.padEnd(14)} ${r.detail}`).join('\n'), data: { checks: rows } };
  },
});

defineVerb({
  name: 'mcp', group: 'internal', local: true, mcp: false, desc: 'Run as an MCP server over stdio (every verb becomes a tool).', args: {},
  async run(ctx) { const { serveMcp } = await import('../mcp.mjs'); await serveMcp({ cwd: ctx.cwd, project: ctx.cfg.projectFile }); },
});
