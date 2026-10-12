// ahkh selftest: proves the harness's own guarantees using the canary scripts - nothing may touch the user's session.
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { defineVerb, VERBS } from './registry.mjs';
import { Session } from '../session.mjs';
import { Run } from '../evidence.mjs';
import { HostClient } from '../host.mjs';
import { findAhk, findLspExtension } from '../config.mjs';
import { LspClient } from '../lsp/client.mjs';
import { sleep, exists, readText, writeJson, fmtMs, truncate, sha1File, ensureDir, readJson } from '../util.mjs';
import { resolveAhk, ahkArgs } from '../adapters/ahk2.mjs';
import { prepareTarget } from '../overlay.mjs';

const CAN = (cfg, n) => path.join(cfg.harnessRoot, 'examples', 'canary', n);

defineVerb({
  name: 'selftest', group: 'core',
  desc: 'Prove the harness works and stays invisible: runs the canary scripts (MsgBox, errors, hang, GUI, focus/clipboard thief) and asserts nothing reached your session.',
  args: { quick: { type: 'boolean', desc: 'skip the slower checks (hang, LSP, GUI driving)' }, only: { type: 'string', desc: 'run only checks whose name contains this' } },
  async run(ctx, a) {
    const cfg = ctx.cfg; const rows = [];
    const run = new Run(cfg, { label: 'selftest', kind: 'selftest' });
    const runVerb = (name, args) => VERBS.get(name).run(ctx, args);
    const stdoutOf = (r) => { try { return readText(path.join(r.runDir, 'procs', 'main', 'stdout.txt')); } catch { return ''; } };
    const findings = (r) => r.data?.findings || [];
    async function check(name, fn, { slow = false } = {}) {
      if (a.only && !name.includes(a.only)) return;
      if (a.quick && slow) { rows.push({ name, status: 'skip', ms: 0, detail: 'skipped (--quick)' }); return; }
      const t = Date.now();
      try { const d = await fn(); rows.push({ name, status: 'pass', ms: Date.now() - t, detail: d || '' }); }
      catch (e) { rows.push({ name, status: 'FAIL', ms: Date.now() - t, detail: e.message }); }
      run.event('selftest.check', rows[rows.length - 1]);
    }
    const ok = (c, msg) => { if (!c) throw new Error(msg); };

    // -- native host -----------------------------------------------------------------
    await check('host: starts, creates a hidden desktop', async () => {
      const h = new HostClient({ exe: cfg.hostExe }); const ready = await h.start();
      try { ok(/^AHKH_/.test(ready.desktop), 'desktop name'); const dl = await h.request('desk.list'); ok(dl.includes(ready.desktop), 'desktop not listed'); return `${ready.desktop} ${ready.screen.join('x')}`; }
      finally { await h.close(); }
    });
    await check('host: desktop disappears after close (no orphans)', async () => {
      const h = new HostClient({ exe: cfg.hostExe }); const ready = await h.start(); await h.close(); await sleep(400);
      const h2 = new HostClient({ exe: cfg.hostExe }); await h2.start(); try { const dl = await h2.request('desk.list'); ok(!dl.includes(ready.desktop), `orphaned desktop ${ready.desktop}`); } finally { await h2.close(); }
    });

    // -- run + catch -------------------------------------------------------------------
    await check('run: clean script passes, stdout captured', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'ok.ahk'), timeout: 15 }); ok(r.verdict === 'PASS', `verdict ${r.verdict}`); ok(/hello from ok/.test(stdoutOf(r)), 'stdout missing');
    });
    await check('run: exit code reported', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'exit-code.ahk'), timeout: 15 }); ok(r.verdict === 'FAIL', `verdict ${r.verdict}`); ok(findings(r).some((f) => f.kind === 'exit-code' && /3/.test(f.message)), 'exit-code finding missing');
    });
    await check('catch: MsgBox is dismissed and screenshotted (script continues)', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'msgbox.ahk'), timeout: 15 }); ok(r.verdict === 'PASS', `verdict ${r.verdict}`);
      ok(/after-msgbox result=Yes/.test(stdoutOf(r)), 'script did not continue past MsgBox');
      const shot = r.data.artifacts.find((x) => x.kind === 'shot'); ok(shot && !shot.blank, 'no non-blank screenshot');
    });
    await check('catch: AHK runtime error dialog -> ERROR with source line + screenshot', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'runtime-error.ahk'), timeout: 15 }); ok(r.verdict === 'ERROR', `verdict ${r.verdict}`);
      const f = findings(r).find((x) => x.kind === 'ahk-error'); ok(f && f.line === 6, `line ${f?.line}`); ok(r.data.artifacts.some((x) => x.kind === 'shot'), 'no screenshot');
    });
    await check('catch: --keep-going presses Continue and the script continues', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'runtime-error.ahk'), timeout: 15, keepGoing: true }); ok(/after-error/.test(stdoutOf(r)), 'did not continue');
    });
    await check('catch: load-time syntax error parsed with line', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'load-error.ahk'), timeout: 15 }); const f = findings(r).find((x) => x.kind === 'load-error'); ok(f && f.line === 4, `finding ${JSON.stringify(f)?.slice(0, 120)}`);
    });
    await check('catch: #Warn dialog pressed Continue (locale-independent ids)', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'warn.ahk'), timeout: 15 }); ok(findings(r).some((f) => f.kind === 'ahk-warning'), 'no warning finding');
    });
    await check('catch: InputBox + FileSelect dialogs closed', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'dialogs.ahk'), timeout: 20 }); ok(r.verdict === 'PASS', `verdict ${r.verdict}`); ok(r.data.dialogs >= 2, `dialogs ${r.data.dialogs}`);
    });
    await check('catch: hung window detected', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'hang.ahk'), for: 8, noFinalShot: true }); ok(findings(r).some((f) => f.kind === 'hung'), 'hang not detected'); ok(r.verdict === 'HUNG', `verdict ${r.verdict}`);
    }, { slow: true });

    // -- probe + patch -------------------------------------------------------------------
    await check('probe: /include injects without editing the script; error chained', async () => {
      const r = await runVerb('run', { script: CAN(cfg, 'runtime-error.ahk'), timeout: 15, probe: true, probeOnError: 'exit' });
      const f = findings(r).find((x) => x.kind === 'runtime-error'); ok(f && f.line === 6, 'probe error missing'); ok(!r.data.dialogs, 'a dialog appeared');
    });
    await check('patch: shadow copy patched, original untouched', async () => {
      const orig = path.join(cfg.harnessRoot, 'examples', 'canary', 'warn.ahk'); const before = sha1File(orig);
      const r = await runVerb('patch', { script: orig, patch: ['warn-stdout'] }); ok(/StdOut/.test(readText(r.data.entry)), 'patch not applied'); ok(sha1File(orig) === before, 'ORIGINAL WAS MODIFIED');
    });

    // -- interactive driving -------------------------------------------------------------
    await check('drive: GUI controls listed, typed/checked/selected/pressed', async () => {
      const s = await Session.open(ctx, { label: 'selftest-gui', kind: 'selftest' });
      try {
        const exe = findAhk(cfg); await s.launch({ name: 'main', exe, args: ['/ErrorStdOut=UTF-8', CAN(cfg, 'gui.ahk')], cwd: path.dirname(CAN(cfg, 'gui.ahk')), scriptName: 'gui.ahk', expect: 'running' });
        await s.waitWindow({ kind: 'ahk-gui' }, 8000); await sleep(400);
        const t = await s.tree({}); ok(t.controls.filter((c) => c.visible).length >= 7, 'expected >=7 controls');
        const edit = t.controls.find((c) => c.kind === 'edit'), cb = t.controls.find((c) => c.kind === 'checkbox'), combo = t.controls.find((c) => c.kind === 'combo'), btn = t.controls.find((c) => c.kind === 'button' && /Hello/.test(c.text));
        await s.type({ hwnd: edit.hwnd }, 'abc'); await s.check({ hwnd: cb.hwnd }, 'true'); await s.select({ hwnd: combo.hwnd }, { index: 1 }); await s.press({ hwnd: btn.hwnd });
        await s.waitOutput('button-hello name=abc', 4000); await s.waitOutput('checkbox=1', 2000); await s.waitOutput('choice=Beta', 2000);
        const sh = await s.shot({ target: { hwnd: t.hwnd }, rect: [10, 140, 300, 40], scale: 2, label: 'closeup' }); ok(!sh.blank && sh.width === 600, `closeup ${sh.width}x${sh.height} blank=${sh.blank}`);
        const u = await s.uia({}); ok(u.count >= 8, `UIA nodes ${u.count}`);
        return `${t.controls.length} controls, UIA ${u.count} nodes`;
      } finally { await s.close({ summary: 'selftest gui' }); }
    }, { slow: true });
    await check('drive: hotkeys fired via WM_HOTKEY (no keyboard input)', async () => {
      const s = await Session.open(ctx, { label: 'selftest-hotkeys', kind: 'selftest' });
      try {
        const exe = findAhk(cfg); await s.launch({ name: 'main', exe, args: ['/ErrorStdOut=UTF-8', CAN(cfg, 'hotkeys.ahk')], cwd: path.dirname(CAN(cfg, 'hotkeys.ahk')), scriptName: 'hotkeys.ahk', expect: 'running' });
        await s.waitOutput('hotkeys-ready', 6000);
        const w = (await s.windowsList({ all: true })).find((x) => x.class === 'AutoHotkey'); ok(w, 'no AHK main window');
        for (let i = 0; i < 5; i++) { await s.host.request('win.msg', { hwnd: w.hwnd, msg: 0x312, wparam: i, lparam: 0, post: true }); await sleep(120); }
        await s.waitOutput('F13 counter=1', 2000); await s.waitOutput('F16-hook-fired', 2000); await s.waitOutput('F17-tilde-fired', 2000);
      } finally { await s.close({ summary: 'selftest hotkeys' }); }
    }, { slow: true });

    // -- vision: what the screen would show ------------------------------------------------
    const openComposed = async (label, probe) => {
      const s = await Session.open(ctx, { label, kind: 'selftest' });
      const script = CAN(cfg, 'composed.ahk'); const { exe } = resolveAhk(cfg, script);
      const prepared = await prepareTarget(ctx, s, script, { probe: probe ? 'rpc' : false });
      if (prepared.cleanup) s.hooks.onClose.push(async () => prepared.cleanup());
      await s.launch({ name: 'main', exe, cwd: prepared.cwd || path.dirname(script), scriptName: 'composed.ahk', expect: 'running', args: ahkArgs({ script: prepared.entry, includes: prepared.includes || [] }), env: prepared.env || {} });
      await s.waitOutput(/^ready$/, 8000); await sleep(300);
      return s;
    };
    const near = (px, [r, g, b], tol = 12) => Math.abs(px.r - r) <= tol && Math.abs(px.g - g) <= tol && Math.abs(px.b - b) <= tol;
    await check('vision: composed shot = layered alpha, DWM thumbnail, layered attrs, excluded window; GDI shots never wipe layered windows', async () => {
      const s = await openComposed('selftest-composed', false);
      try {
        await s.shot({ desktop: true, tech: 'composite', label: 'gdi', maxEdge: 0 });          // PrintWindow-based: must leave the layered window alone
        const r = await s.shot({ desktop: true, composed: true, bg: '#000000', label: 'composed', maxEdge: 0 });
        const px = async (x, y) => s.host.request('img.pixel', { src: r.path, x, y });
        const want = [[200, 250, [0, 128, 0], 'plain'], [350, 250, [128, 64, 0], 'per-pixel alpha over green'], [450, 250, [0, 0, 255], 'opaque layered'],
          [310, 250, [0, 128, 0], 'alpha-0 strip shows the window below'], [700, 150, [128, 128, 128], 'SetLayeredWindowAttributes 128'],
          [700, 350, [255, 128, 0], 'excluded from capture'], [250, 600, [0, 128, 0], 'DWM thumbnail in a no-redirection window']];
        for (const [x, y, rgb, what] of want) { const p = await px(x, y); ok(near(p, rgb), `${what} at ${x},${y}: got ${p.hex}, want rgb(${rgb})`); }
        ok(r.unreadable?.length === 1, `unreadable: ${JSON.stringify(r.unreadable)}`);
        // the synthetic mouse: click-through on the alpha-0 strip lands on the window below
        const m = await s.host.request('win.mouse', { action: 'click', x: 310, y: 250 });
        ok(m.topTitle === 'composed-plain' && m.passedThrough?.title === 'composed-ulw', `mouse routed to ${m.topTitle} (passed ${m.passedThrough?.title})`);
        await s.waitOutput(/^down 2\d\d,119$/, 3000);
        return `${r.layers.length} windows in ${r.composeMs}ms, 1 unreadable (excluded + layered), click-through ok`;
      } finally { await s.close({ summary: 'selftest composed' }); }
    }, { slow: true });
    await check('vision: probe lifts its own capture exclusion for a composed shot; Ahkh.Shot from inside; synthetic cursor', async () => {
      const s = await openComposed('selftest-composed-probe', true);
      try {
        const r = await s.shot({ desktop: true, composed: true, bg: '#000000', label: 'lifted', maxEdge: 0 });
        ok(!r.unreadable?.length && r.unexcluded?.length === 2, `unreadable ${JSON.stringify(r.unreadable)} unexcluded ${r.unexcluded?.length}`);
        const p = await s.host.request('img.pixel', { src: r.path, x: 950, y: 150 }); ok(near(p, [255, 255, 0]), `excluded layered window: ${p.hex}`);
        const inside = await s.probe.call('shot', { label: 'from-probe' }, 15000); ok(inside.technique === 'composed' && inside.layers.length >= 5, `probe shot ${inside.technique} ${inside.layers?.length}`);
        await s.host.request('win.mouse', { action: 'move', x: 222, y: 333 });
        await s.waitOutput(/cursor 222,333$/, 3000);
        return `probe shot ${inside.width}x${inside.height}; MouseGetPos follows the synthetic cursor`;
      } finally { await s.close({ summary: 'selftest composed probe' }); }
    }, { slow: true });

    // -- LSP -------------------------------------------------------------------------------
    await check('lsp: language server runs in the hidden desktop and reports errors', async () => {
      if (!findLspExtension(cfg)) return 'skipped: extension not installed';
      const c = new LspClient(cfg); await c.start({ rootDir: path.dirname(CAN(cfg, 'ok.ahk')) });
      try { const r = await c.diagnostics(CAN(cfg, 'load-error.ahk')); ok(r.diagnostics.some((d) => d.severity === 'error'), 'no error diagnostic'); const clean = await c.diagnostics(CAN(cfg, 'ok.ahk')); ok(!clean.diagnostics.some((d) => d.severity === 'error'), 'false positive on clean file'); return `${r.diagnostics.length} diag(s)`; }
      finally { await c.stop(); }
    }, { slow: true });

    // -- containment: the point of the whole exercise ---------------------------------------------
    await check('containment: focus/mouse thief cannot touch the real session; clipboard wipe is undone', async () => {
      // Use a sentinel on the real clipboard, then put back whatever text the user had (text only: never disturb images/files).
      const ps = (cmd) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
      const original = ps('Get-Clipboard -Raw').stdout;
      const hadNonText = ps('(Get-Clipboard -Format FileDropList).Count; if (Get-Clipboard -Format Image) { "IMG" }').stdout.trim().length > 1;
      try {
        if (!hadNonText) ps("Set-Clipboard -Value 'AHKH-SELFTEST-SENTINEL'");
        const r = await runVerb('run', { script: CAN(cfg, 'steal-focus.ahk'), timeout: 20, noFinalShot: true });
        const g = r.data.guard; ok(g, 'no guard report');
        ok(g.count === 0 || g.violations.every((v) => v.kind === 'clipboard-touched' && v.restored), `guard violations: ${JSON.stringify(g.violations).slice(0, 200)}`);
        ok(!findings(r).some((f) => /^guard/.test(f.kind)), 'guard error finding recorded');
        await sleep(300);
        if (!hadNonText) ok(ps('Get-Clipboard -Raw').stdout.trim() === 'AHKH-SELFTEST-SENTINEL', 'CLIPBOARD WAS NOT RESTORED');
        return `clipboard touched ${g.clipboardChangedByTarget}x and restored; foreground/window checks clean`;
      } finally {
        if (!hadNonText) {
          // put the user's original TEXT back (single-quoted PowerShell string: only the quote needs doubling)
          const text = original.trimEnd();
          ps(text.trim() ? `Set-Clipboard -Value '${text.replace(/'/g, "''")}'` : 'Set-Clipboard -Value $null');
        }
      }
    });

    await check('containment: console children (Run powershell/cmd) never reach the real desktop via the default terminal', async () => {
      // Windows 11 hands every NEW console to Windows Terminal, which opens it on the user's desktop. The host must block it
      // (native/Host.Console.cs). Independent proof: the console/terminal windows on the real desktop are the same before and after.
      const listCmd = 'Add-Type -TypeDefinition \'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public static class AhkhCW { delegate bool EP(IntPtr h, IntPtr l); [DllImport("user32")] static extern bool EnumWindows(EP f, IntPtr l); [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n); public static string List() { var r = new List<string>(); EnumWindows(delegate (IntPtr h, IntPtr l) { var s = new StringBuilder(256); GetClassName(h, s, 256); var c = s.ToString(); if (c == "CASCADIA_HOSTING_WINDOW_CLASS" || c == "ConsoleWindowClass") r.Add(c + ":" + h.ToInt64()); return true; }, IntPtr.Zero); return string.Join(" ", r.ToArray()); } }\'; [AhkhCW]::List()';
      const consoleWindows = () => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', listCmd], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\s+/).filter(Boolean);
      const before = new Set(consoleWindows());
      const r = await runVerb('run', { script: CAN(cfg, 'console-children.ahk'), timeout: 20, noFinalShot: true });
      await sleep(1500);   // a delegated terminal window takes a moment to appear
      const appeared = consoleWindows().filter((w) => !before.has(w));
      ok(appeared.length === 0, `NEW console/terminal window(s) on the real desktop: ${appeared.join(' ')}`);
      ok(r.verdict === 'PASS', `verdict ${r.verdict}: ${findings(r).map((f) => f.message).join(' | ').slice(0, 200)}`);
      ok(!findings(r).some((f) => /^guard/.test(f.kind)), 'guard error finding recorded');
      ok(/console-children ps=/.test(stdoutOf(r)), 'canary did not finish');
      const blocked = findings(r).filter((f) => f.kind === 'console-blocked').length;
      ok(blocked >= 2, `expected >= 2 console-blocked warnings, got ${blocked}`);
      return `${blocked} new console(s) blocked before handoff; no window appeared`;
    });

    await check('containment: a console window on the hidden desktop (launch --console) never reads or writes the host\'s own pipes; composed shots of it work', async () => {
      // conhost given the host's std handles became a VT pty over them: it ate the host's requests (typed into cmd as keyboard input),
      // wrote VT sequences into the host's event stream ("host.garbage"), and every shot after it timed out until the hub went down.
      const s = await Session.open(ctx, { label: 'selftest-console', kind: 'selftest' });
      let garbage = 0; const prev = s.host.onEvent;
      s.host.onEvent = (e) => { if (e.event === 'host.garbage') garbage++; return prev(e); };
      try {
        await s.launch({ name: 'con', exe: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/k', 'echo AHKH-CONSOLE-MARK'], expect: 'running', console: true });
        let w = null; for (let i = 0; i < 50 && !w; i++) { await sleep(100); w = (await s.windowsList({ all: true })).find((x) => x.class === 'ConsoleWindowClass'); }
        ok(w, 'no console window on the hidden desktop');
        const t = Date.now();
        for (const o of [{ target: w.hwnd }, { target: w.hwnd, composed: true }, { desktop: true }]) {
          const r = await s.shot({ ...o, label: 'console', maxEdge: 0 }); ok(r && r.path && !r.blank, `shot ${JSON.stringify(o)} blank or missing`);
        }
        ok(garbage === 0, `${garbage} garbage line(s) on the host's stdout: the console is using the host's pipes`);
        return `console window ${w.hwnd}: 3 shots in ${Date.now() - t}ms, host pipes untouched`;
      } finally { await s.close({ summary: 'selftest console' }); }
    });

    const failed = rows.filter((r) => r.status === 'FAIL').length;
    const passed = rows.filter((r) => r.status === 'pass').length, skipped = rows.filter((r) => r.status === 'skip').length;
    const lines = rows.map((r) => `${r.status === 'pass' ? '✓' : r.status === 'skip' ? '·' : '✗'} ${r.name.padEnd(74)} ${String(fmtMs(r.ms)).padStart(7)}  ${r.status === 'pass' ? truncate(r.detail, 60) : r.detail}`);
    const verdict = failed ? 'FAIL' : 'PASS';
    run.finish({ verdict, summary: `${passed} of ${rows.length} checks passed${skipped ? `, ${skipped} skipped` : ''}`, data: { checks: rows } });
    ensureDir(path.join(cfg.root, '.ahkh')); writeJson(path.join(cfg.root, '.ahkh', 'selftest.json'), { at: new Date().toISOString(), verdict, failed, total: rows.length });
    return { verdict, summary: `${verdict}  selftest  ${passed}/${rows.length} passed${skipped ? `, ${skipped} skipped (--quick)` : ''}\n${lines.join('\n')}\n  run: ${run.dir}`, data: { checks: rows }, runDir: run.dir, exitCode: failed ? 1 : 0 };
  },
});
