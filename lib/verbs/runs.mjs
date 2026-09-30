// Run-folder utilities, image tools, project scaffolding and profiles.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defineVerb, VERBS } from './registry.mjs';
import { HostClient } from '../host.mjs';
import { listRuns, pruneRuns, renderSummary } from '../evidence.mjs';
import { readJson, readText, exists, ensureDir, writeFile, fmtMs, truncate, AhkhError, HARNESS_ROOT, walk } from '../util.mjs';

export async function withImages(ctx, fn) {
  const h = new HostClient({ exe: ctx.cfg.hostExe, imagesOnly: true }); await h.start();
  try { return await fn(h); } finally { await h.close(); }
}

function resolveRun(ctx, name) {
  const runs = listRuns(ctx.cfg);
  if (!runs.length) throw new AhkhError('no runs yet', 'NORUNS');
  const n = !name || name === 'latest' ? runs[0] : runs.find((r) => r === name) || runs.find((r) => r.includes(name));
  if (!n) throw new AhkhError(`no such run: ${name}`, 'NORUN');
  return { name: n, dir: path.join(ctx.cfg.outDir, n) };
}

defineVerb({
  name: 'runs', group: 'runs', local: true, desc: 'List recent runs (newest first) with verdicts.', args: { limit: { type: 'number', default: 15 } },
  async run(ctx, a) {
    const rows = listRuns(ctx.cfg).slice(0, a.limit).map((n) => { const r = readJson(path.join(ctx.cfg.outDir, n, 'result.json'), null); return { name: n, verdict: r?.verdict || '(running/incomplete)', kind: r?.kind, ms: r?.durationMs, summary: r?.summary }; });
    return { ok: true, summary: rows.map((r) => `${String(r.verdict).padEnd(12)} ${r.name}  ${r.ms != null ? fmtMs(r.ms) : ''}  ${truncate(r.summary || '', 70)}`).join('\n') || '(no runs)', data: rows };
  },
});

defineVerb({
  name: 'run.show', group: 'runs', local: true, desc: 'Show a run\'s summary (default: latest). --files lists its artifacts.',
  args: { run: { type: 'string', positional: 0, default: 'latest' }, files: { type: 'boolean' } },
  async run(ctx, a) {
    const r = resolveRun(ctx, a.run);
    if (a.files) return { ok: true, summary: walk(r.dir, { skip: [] }).map((f) => path.relative(r.dir, f).replace(/\\/g, '/')).join('\n'), data: {} };
    const res = readJson(path.join(r.dir, 'result.json'), null);
    return { ok: true, summary: res ? renderSummary(res) : readText(path.join(r.dir, 'summary.md')), data: res, runDir: r.dir };
  },
});

defineVerb({
  name: 'runs.prune', group: 'runs', local: true, desc: 'Delete old run folders, keeping the newest N.', args: { keep: { type: 'number', default: 30 } },
  async run(ctx, a) { const n = pruneRuns({ ...ctx.cfg, keepRuns: a.keep }); return { ok: true, summary: `pruned ${n} run folder(s)` }; },
});

defineVerb({
  name: 'runs.pack', group: 'runs', local: true, desc: 'Zip a run folder (evidence bundle for bug reports).', args: { run: { type: 'string', positional: 0, default: 'latest' }, out: { type: 'string' } },
  async run(ctx, a) {
    const r = resolveRun(ctx, a.run); const out = path.resolve(ctx.cwd, a.out || `${r.name}.zip`);
    const p = spawnSync('tar', ['-a', '-c', '-f', out, '-C', r.dir, '.'], { encoding: 'utf8', windowsHide: true });
    if (p.status !== 0) throw new AhkhError('tar failed: ' + (p.stderr || p.error?.message), 'NOTAR');
    return { ok: true, summary: `${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`, data: { out } };
  },
});

defineVerb({
  name: 'runs.sheet', group: 'runs', local: true, desc: 'Contact sheet of a finished run\'s screenshots (one image instead of many).',
  args: { run: { type: 'string', positional: 0, default: 'latest' }, last: { type: 'number', default: 9 }, cols: { type: 'number', default: 3 }, cellWidth: { type: 'number', default: 480 } },
  async run(ctx, a) {
    const r = resolveRun(ctx, a.run); const res = readJson(path.join(r.dir, 'result.json'), { artifacts: [] });
    const shots = res.artifacts.filter((x) => x.kind === 'shot' && !x.blank).slice(-a.last).map((x) => path.join(r.dir, x.rel));
    if (!shots.length) throw new AhkhError('that run has no screenshots', 'NOSHOTS');
    const out = path.join(r.dir, 'shots', `sheet_${Date.now() % 100000}.png`);
    const s = await withImages(ctx, (h) => h.request('img.sheet', { files: shots, labels: shots.map((f) => path.basename(f, '.png')), out, cols: a.cols, cellWidth: a.cellWidth }));
    return { ok: true, summary: `${out} (${s.cells} frames)`, images: [out], data: s };
  },
});

// ---------------------------------------------------------------------- images

const abs = (ctx, p) => path.resolve(ctx.cwd, p);
defineVerb({
  name: 'img.sheet', group: 'images', local: true, desc: 'Stitch images into one labelled contact sheet.',
  args: { files: { type: 'array', positional: 'rest', required: true }, out: { type: 'string', required: true }, cols: { type: 'number', default: 3 }, cellWidth: { type: 'number', default: 480 } },
  async run(ctx, a) { const files = a.files.map((f) => abs(ctx, f)); const out = abs(ctx, a.out); const r = await withImages(ctx, (h) => h.request('img.sheet', { files, labels: files.map((f) => path.basename(f, '.png')), out, cols: a.cols, cellWidth: a.cellWidth })); return { ok: true, summary: `${out} ${r.width}x${r.height}`, images: [out], data: r }; },
});
defineVerb({
  name: 'img.diff', group: 'images', local: true, desc: 'Pixel diff of two images with tolerance; writes a red-highlight diff image. Exit code 1 when different.',
  args: { a: { type: 'string', positional: 0, required: true }, b: { type: 'string', positional: 1, required: true }, out: { type: 'string' }, tolerance: { type: 'number', default: 8 }, region: { type: 'array', greedy: 4, desc: 'x,y,w,h to compare' }, maxPct: { type: 'number', default: 0, desc: 'allowed changed % before failing' } },
  async run(ctx, a) {
    const out = a.out ? abs(ctx, a.out) : undefined;
    const r = await withImages(ctx, (h) => h.request('img.diff', { a: abs(ctx, a.a), b: abs(ctx, a.b), out, tolerance: a.tolerance, region: a.region?.map(Number) }));
    const same = r.same || (r.changedPct != null && r.changedPct <= a.maxPct);
    return { verdict: same ? 'PASS' : 'FAIL', summary: `${same ? 'PASS' : 'FAIL'}  ${r.sizeMismatch ? `size mismatch ${r.aSize} vs ${r.bSize}` : `${r.changedPct}% changed (${r.changedPixels} px)${r.bbox ? ' bbox ' + r.bbox.join(',') : ''}`}${r.diffPath ? '\n  diff: ' + r.diffPath : ''}`, images: r.diffPath ? [r.diffPath] : [], data: r, exitCode: same ? 0 : 1 };
  },
});
defineVerb({
  name: 'img.crop', group: 'images', local: true, desc: 'Crop (and optionally scale) part of an image: a closeup.',
  args: { src: { type: 'string', positional: 0, required: true }, out: { type: 'string', required: true }, rect: { type: 'array', greedy: 4, desc: 'x,y,w,h' }, scale: { type: 'number', default: 1 } },
  async run(ctx, a) { const r = await withImages(ctx, (h) => h.request('img.crop', { src: abs(ctx, a.src), out: abs(ctx, a.out), rect: a.rect?.map(Number), scale: a.scale })); return { ok: true, summary: `${r.path} ${r.width}x${r.height}`, images: [r.path], data: r }; },
});
defineVerb({
  name: 'img.pixel', group: 'images', local: true, desc: 'Colour of one pixel (assert on rendered output).', args: { src: { type: 'string', positional: 0, required: true }, x: { type: 'number', positional: 1, required: true }, y: { type: 'number', positional: 2, required: true } },
  async run(ctx, a) { const r = await withImages(ctx, (h) => h.request('img.pixel', { src: abs(ctx, a.src), x: a.x, y: a.y })); return { ok: true, summary: r.hex, data: r }; },
});
defineVerb({
  name: 'img.dominant', group: 'images', local: true, desc: 'Dominant + average colour of a region.', args: { src: { type: 'string', positional: 0, required: true }, rect: { type: 'array', greedy: 4 } },
  async run(ctx, a) { const r = await withImages(ctx, (h) => h.request('img.dominant', { src: abs(ctx, a.src), rect: a.rect?.map(Number) })); return { ok: true, summary: `dominant ${r.dominant}  average ${r.average}`, data: r }; },
});

// ---------------------------------------------------------------------- init + profiles

defineVerb({
  name: 'init', group: 'project', local: true, desc: 'Scaffold an ahkh.json (+ patches/ and rules/ folders) in a project: --profile lint|smoke|gui|bench.',
  args: { dir: { type: 'string', positional: 0, default: '.' }, profile: { type: 'string', default: 'smoke' }, force: { type: 'boolean' } },
  async run(ctx, a) {
    const dir = abs(ctx, a.dir); const file = path.join(dir, 'ahkh.json');
    if (exists(file) && !a.force) throw new AhkhError(`${file} already exists (use --force)`, 'EXISTS');
    const tpl = readJson(path.join(HARNESS_ROOT, 'templates', `${a.profile}.json`), null);
    if (!tpl) throw new AhkhError(`unknown profile "${a.profile}" (see templates/)`, 'NOPROFILE');
    ensureDir(dir); writeFile(file, JSON.stringify(tpl, null, 2) + '\n');
    for (const d of ['patches', 'rules']) ensureDir(path.join(dir, d));
    writeFile(path.join(dir, 'rules', 'README.md'), 'Dialog rules: JSON arrays of {name, match:{kind,class,title,text,button,proc}, do:{shot,press,type,close,kill,ignore,verdict}}.\nReference them from ahkh.json "rules" or pass --rules.\n');
    writeFile(path.join(dir, 'patches', 'README.md'), 'Patch recipes: {name, desc, ops:[{op:replace|prepend|append|insertAfter|insertBefore|delete|include|stub, file, ...}]}. Use: ahkh run x.ahk --patch <name>.\n');
    const gi = path.join(dir, '.gitignore'); const add = '.ahkh/\nruns/\n';
    if (!exists(gi) || !readText(gi).includes('.ahkh/')) fs.appendFileSync(gi, (exists(gi) ? '\n' : '') + add);
    return { ok: true, summary: `created ${file} (profile ${a.profile})\n  next: ahkh doctor ; ahkh selftest ; ahkh profile ${a.profile === 'lint' ? 'lint' : 'smoke'} <script>`, data: tpl };
  },
});

defineVerb({
  name: 'profile', group: 'project', local: true, desc: 'Run a named profile (built-in or from ahkh.json "profiles"): lint | smoke | quick | ci.',
  args: { name: { type: 'string', positional: 0, required: true }, target: { type: 'array', positional: 'rest', desc: 'files/folders the profile applies to' } },
  async run(ctx, a) {
    const builtin = readJson(path.join(HARNESS_ROOT, 'profiles', `${a.name}.json`), null);
    const prof = ctx.cfg.profiles?.[a.name] || builtin;
    if (!prof) throw new AhkhError(`unknown profile ${a.name}`, 'NOPROFILE');
    const steps = prof.steps || [prof];
    const out = []; let worst = 0;
    for (const st of steps) {
      const def = VERBS.get(st.verb); if (!def) throw new AhkhError(`profile step uses unknown verb ${st.verb}`, 'BADPROFILE');
      const args = { ...(st.args || {}) };
      const posName = Object.entries(def.args).find(([, s]) => s.positional === 'rest' || s.positional === 0)?.[0];
      if (posName && a.target?.length) args[posName] = def.args[posName].type === 'array' ? a.target : a.target[0];
      const r = await def.run(ctx, args); out.push(`── ${st.verb}\n${r.summary}`); worst = Math.max(worst, r.exitCode || 0);
    }
    return { verdict: worst ? 'FAIL' : 'PASS', summary: out.join('\n\n'), exitCode: worst };
  },
});
