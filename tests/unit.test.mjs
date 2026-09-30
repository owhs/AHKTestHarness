// Unit tests: pure logic only (no desktop, no AutoHotkey). Run: node --test tests/     (or: bun test)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgv, finalize, jsonSchema, VERBS } from '../lib/verbs/registry.mjs';
import '../lib/verbs/index.mjs';
import { codeMasks, buildOverlay, loadRecipes } from '../lib/overlay.mjs';
import { parseSelector } from '../lib/session.mjs';
import { ddmin } from '../lib/modules/reduce.mjs';
import { buildIncludeGraph } from '../lib/modules/includes.mjs';
import { pathToUri, uriToPath } from '../lib/lsp/client.mjs';
import { diagKey, renderText, renderSarif } from '../lib/lsp/report.mjs';
import { worstVerdict, Run, VERDICT_EXIT } from '../lib/evidence.mjs';
import { parseAhkOutput, mapLine, ahkArgs } from '../lib/adapters/ahk2.mjs';
import { handleProbeLine } from '../lib/probe.mjs';
import { signature, quoteArg, globToRegExp, expandPaths } from '../lib/util.mjs';
import { staticScan } from '../lib/modules/smoke.mjs';
import { loadConfig } from '../lib/config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ahkh-test-'));
const write = (dir, name, text) => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

// ---------------------------------------------------------------------- argument parsing

test('parseArgv: positional, flags, aliases, negation, greedy arrays (PowerShell comma splitting)', () => {
  const shot = VERBS.get('shot');
  const a = parseArgv(shot, ['w1', '--rect', '10', '140', '410', '40', '--scale', '2', '--label', 'x', '-s', 's9']);
  assert.equal(a.target, 'w1'); assert.deepEqual(a.rect, ['10', '140', '410', '40']); assert.equal(a.scale, 2); assert.equal(a.session, 's9');
  const b = parseArgv(shot, ['--rect=1,2,3,4']); assert.deepEqual(b.rect, ['1', '2', '3', '4']);
  const run = VERBS.get('run');
  const c = parseArgv(run, ['x.ahk', '--keep-going', '--no-keep-going', '--for', '3']); assert.equal(c.keepGoing, false); assert.equal(c.for, 3);
  assert.throws(() => parseArgv(run, ['x.ahk', '--nonsense']), /unknown option/);
  assert.throws(() => parseArgv(run, []), /missing required/);
});

test('finalize: defaults + required; jsonSchema exposes them', () => {
  const def = VERBS.get('burst'); const a = finalize(def, {}); assert.equal(a.count, 6);
  const sch = jsonSchema(VERBS.get('run')); assert.deepEqual(sch.required, ['script']); assert.equal(sch.properties.for.type, 'number');
});

test('every verb has a description and a runnable schema', () => {
  assert.ok(VERBS.size > 50);
  for (const [name, def] of VERBS) { assert.ok(def.desc, name + ' desc'); assert.equal(typeof def.run, 'function', name); jsonSchema(def); }
});

// ---------------------------------------------------------------------- code masks + patch engine

test('codeMasks: strings, comments, block comments and continuation sections are not code', () => {
  const lines = ['x := "MsgBox(1)" ; MsgBox(2)', 'MsgBox(3)', '/*', 'MsgBox(4)', '*/', 'a := \"', '(', '  MsgBox(5)', ')\"', "s := 'Run(x)' Run(y)"];
  const m = codeMasks(lines);
  assert.ok(!m[0][lines[0].indexOf('MsgBox')]); assert.ok(!m[0][lines[0].lastIndexOf('MsgBox')]);
  assert.ok(m[1][0]); assert.ok(!m[3][0]); assert.ok(!m[7][2]);
  assert.ok(!m[9][lines[9].indexOf('Run')]); assert.ok(m[9][lines[9].lastIndexOf('Run')]);
});

function overlayFor(text, ops, extra = {}) {
  const dir = tmp(); const script = write(dir, 'main.ahk', text);
  for (const [n, t] of Object.entries(extra)) write(dir, n, t);
  const outDir = tmp();
  const cfg = { outDir, root: dir, harnessRoot: path.resolve('.'), keepRuns: 0 };
  const run = new Run(cfg, { label: 't' });
  const built = buildOverlay({ cfg, run, script, ops });
  return { built, dir, script, text: fs.readFileSync(built.entry, 'utf8'), run };
}

test('overlay: replace only touches code, never strings/comments; original untouched', () => {
  const src = '#Requires AutoHotkey v2.0\nx := "Sleep(5)" ; Sleep(6)\nSleep(100)\n';
  const r = overlayFor(src, [{ op: 'replace', regex: '\\bSleep\\(', with: 'MySleep(' }]);
  assert.match(r.text, /"Sleep\(5\)"/); assert.match(r.text, /; Sleep\(6\)/); assert.match(r.text, /^MySleep\(100\)/m);
  assert.equal(fs.readFileSync(r.script, 'utf8'), src);
});

test('overlay: prepend goes after #Requires and the line map points back at the original lines', () => {
  const r = overlayFor('#Requires AutoHotkey v2.0\nfoo()\nbar()\n', [{ op: 'prepend', file: 'entry', text: '#Warn All, StdOut\n; hi' }]);
  const lines = r.text.split('\n'); assert.equal(lines[0], '#Requires AutoHotkey v2.0'); assert.equal(lines[1], '#Warn All, StdOut');
  const lm = Object.values(r.built.linemap)[0]; assert.deepEqual(lm.lines.slice(0, 5), [1, null, null, 2, 3]);
  assert.equal(mapLine(r.built.linemap, r.built.entry, 4).line, 2); assert.equal(mapLine(r.built.linemap, r.built.entry, 2).injected, true);
});

test('overlay: stub rewrites call sites (paren + statement form) and generates definitions', () => {
  const r = overlayFor('#Requires AutoHotkey v2.0\nFileDelete("a.txt")\nFileDelete "b.txt"\nobj.FileDelete("keep")\nx := "FileDelete(z)"\n', [{ op: 'stub', calls: ['FileDelete'], returns: '0' }]);
  assert.match(r.text, /Ahkh_Stub_FileDelete\("a.txt"\)/); assert.match(r.text, /Ahkh_Stub_FileDelete "b.txt"/);
  assert.match(r.text, /obj\.FileDelete\("keep"\)/); assert.match(r.text, /"FileDelete\(z\)"/);
  assert.equal(r.built.includes.length, 1); assert.match(fs.readFileSync(r.built.includes[0], 'utf8'), /Ahkh_Stub_FileDelete\(params\*\)/);
});

test('overlay: insertAfter / delete / include ops', () => {
  const r = overlayFor('a := 1\nb := 2\nc := 3\n', [{ op: 'insertAfter', match: '^b :=', text: 'b2 := 22' }, { op: 'delete', match: '^c :=' }]);
  assert.equal(r.text.split('\n').slice(0, 3).join('|'), 'a := 1|b := 2|b2 := 22');
  assert.ok(!/c := 3/.test(r.text));
});

test('overlay: out-of-tree #Include is rewritten to an absolute path', () => {
  const base = tmp(); const proj = path.join(base, 'proj'); fs.mkdirSync(proj); write(base, 'shared/lib.ahk', 'x := 1');
  const script = write(proj, 'main.ahk', '#Include ..\\shared\\lib.ahk\n#Include local.ahk\n'); write(proj, 'local.ahk', 'y := 2');
  const outDir = tmp(); const cfg = { outDir, root: proj, harnessRoot: path.resolve('.'), keepRuns: 0 }; const run = new Run(cfg, { label: 't' });
  const built = buildOverlay({ cfg, run, script, ops: [{ op: 'append', file: 'entry', text: '; touch' }] });
  const text = fs.readFileSync(built.entry, 'utf8');
  assert.match(text, new RegExp('#Include ' + path.join(base, 'shared', 'lib.ahk').replace(/\\/g, '\\\\'))); assert.match(text, /#Include local\.ahk/);
});

test('recipes: built-in names resolve, unknown ones fail clearly', () => {
  const cfg = { root: path.resolve('.'), harnessRoot: path.resolve('.') };
  const { ops, names } = loadRecipes(cfg, ['stub-dangerous', '{"op":"append","text":"; x"}']); assert.ok(ops.length >= 2); assert.deepEqual(names, ['stub-dangerous', 'inline']);
  assert.throws(() => loadRecipes(cfg, ['no-such-recipe']), /not found/);
});

// ---------------------------------------------------------------------- selectors, ddmin, includes

test('selectors: kind:text shorthand, key=value, regex, index', () => {
  const ctl = { kind: 'button', class: 'Button', text: '&Say Hello', id: 7 };
  assert.ok(parseSelector('button:Say Hello').matchCtl(ctl)); assert.ok(!parseSelector('button:Cancel').matchCtl(ctl));
  assert.ok(parseSelector('class=Button&text~=hel').matchCtl(ctl)); assert.ok(parseSelector('id=7').matchCtl(ctl)); assert.ok(!parseSelector('kind!=button').matchCtl(ctl));
  assert.equal(parseSelector('kind=edit&index=2').index, 2);
  assert.ok(parseSelector('title~=Error').matchWin({ title: 'Fatal Error', class: '#32770', kind: 'ahk-error' }));
});

test('ddmin finds the minimal failing subset', async () => {
  const items = Array.from({ length: 40 }, (_, i) => i);
  const r = await ddmin(items, async (s) => s.includes(7) && s.includes(31));
  assert.deepEqual(r.items.sort((a, b) => a - b), [7, 31]);
});

test('include graph: resolves relative/%A_ScriptDir%/<Lib>, reports missing, optional and cycles', () => {
  const d = tmp(); write(d, 'Lib/Util.ahk', 'u := 1'); write(d, 'a.ahk', '#Include b.ahk\n'); write(d, 'b.ahk', '#Include a.ahk\n');
  const main = write(d, 'main.ahk', '#Include %A_ScriptDir%\\a.ahk\n#Include <Util>\n#Include missing.ahk\n#Include *i optional.ahk\n; #Include commented.ahk\ns := "#Include instr.ahk"\n');
  const g = buildIncludeGraph(main);
  assert.equal(g.missing.length, 1); assert.match(g.missing[0].spec, /missing\.ahk/); assert.equal(g.cycles.length, 1);
  assert.ok(g.files.some((f) => /Util\.ahk$/.test(f))); assert.ok(!g.files.some((f) => /commented|instr|optional/.test(f)));
});

// ---------------------------------------------------------------------- lsp helpers

test('lsp URIs match vscode-uri conventions (lowercase drive, %3A, percent-encoded specials)', () => {
  assert.equal(pathToUri('C:\\My Proj\\a(b)#c.ahk'), 'file:///c%3A/My%20Proj/a%28b%29%23c.ahk');
  assert.equal(uriToPath('file:///c%3A/My%20Proj/x.ahk').toLowerCase(), 'c:\\my proj\\x.ahk');
});

test('diagnostic reporters + baseline keys ignore line shifts', () => {
  const d = { file: 'C:\\p\\a.ahk', line: 3, col: 1, endLine: 3, endCol: 4, severity: 'error', code: null, message: "Variable 'x' is undefined at 12", sourceLine: 'x := y' };
  const moved = { ...d, line: 40, message: "Variable 'x' is undefined at 99" };
  assert.equal(diagKey(d, 'C:\\p'), diagKey(moved, 'C:\\p'));
  assert.match(renderText([d], { root: 'C:\\p' }), /3:1\s+error/); assert.equal(JSON.parse(renderSarif([d], { root: 'C:\\p' })).runs[0].results.length, 1);
});

// ---------------------------------------------------------------------- evidence + adapters + protocol

test('verdicts: safety violations outrank everything; exit codes are distinct', () => {
  assert.equal(worstVerdict(['PASS', 'FAIL', 'ERROR']), 'ERROR'); assert.equal(worstVerdict(['ERROR', 'FOCUS-STOLEN']), 'FOCUS-STOLEN'); assert.equal(worstVerdict([]), 'PASS');
  const codes = Object.values(VERDICT_EXIT); assert.equal(new Set(codes.filter((c) => c > 0)).size, codes.filter((c) => c > 0).length);
});

test('AHK output parsing: file (line) : ==> message + Specifically', () => {
  const r = parseAhkOutput('C:\\x\\a.ahk (12) : ==> Missing ")"\n     Specifically: if (1 {\nC:\\x\\a.ahk (30) : ==> Warning: unused');
  assert.equal(r.length, 2); assert.equal(r[0].line, 12); assert.equal(r[0].specifically, 'if (1 {'); assert.equal(r[1].warning, true);
});

test('ahkArgs: exactly one /include (AutoHotkey ignores or chokes on more)', () => {
  const a = ahkArgs({ script: 'x.ahk', includes: ['p.ahk'] }); assert.deepEqual(a, ['/ErrorStdOut=UTF-8', '/include', 'p.ahk', 'x.ahk']);
});

test('probe protocol lines become findings (with line mapping)', () => {
  const findings = []; const events = [];
  const s = { addFinding: (f) => findings.push(f), run: { event: (k, d) => events.push([k, d]) }, extra: {} };
  assert.ok(handleProbeLine(s, 'main', 'AHKH|error|{"message":"boom","file":"a.ahk","line":12}', (f, l) => ({ file: f, line: l - 2 })));
  assert.ok(handleProbeLine(s, 'main', 'AHKH|assert|{"ok":false,"msg":"x==y","expected":1,"actual":2,"file":"a.ahk","line":5}'));
  assert.ok(handleProbeLine(s, 'main', 'AHKH|done|{"pass":3,"fail":1}')); assert.ok(!handleProbeLine(s, 'main', 'plain output'));
  assert.equal(findings[0].kind, 'runtime-error'); assert.equal(findings[0].line, 10); assert.equal(findings[1].kind, 'assertion'); assert.match(findings[1].message, /expected 1, got 2/); assert.equal(s.extra.probeDone.fail, 1);
});

test('static scan finds timers, hotkeys, dangerous calls but ignores strings/comments', () => {
  const d = tmp(); const f = write(d, 's.ahk', 'SetTimer(Tick, 500)\nF1::MsgBox("x")\nFileDelete("a") ; RegDelete()\ns := "Run(x)"\ng := Gui()\n');
  const r = staticScan([f]); assert.deepEqual(r.timers.map((t) => t.fn), ['Tick']); assert.equal(r.hotkeys, 1); assert.equal(r.guis, 1);
  assert.deepEqual(r.dangerous.map((x) => x.call), ['FileDelete']);
});

test('util: signature groups paths/numbers; quoteArg; globs; config discovery', () => {
  assert.equal(signature('Error at C:\\a\\b.ahk line 12: 0x1F'), 'Error at <path> line N: <hex>');
  assert.equal(quoteArg('a b'), '"a b"'); assert.equal(quoteArg('plain'), 'plain'); assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
  assert.ok(globToRegExp('**/*.ahk').test('a/b/c.ahk')); assert.ok(!globToRegExp('*.ahk').test('a/b.ahk'));
  const d = tmp(); write(d, 'ahkh.json', '{"keepRuns":7,"outDir":"out"}'); const cfg = loadConfig({ cwd: d }); assert.equal(cfg.keepRuns, 7); assert.equal(cfg.outDir, path.join(d, 'out'));
  const d2 = tmp(); write(d2, 'a.ahk', ''); write(d2, 'sub/b.ahk', ''); write(d2, 'sub/c.txt', ''); assert.equal(expandPaths([d2]).length, 2);
});
