// Run folders: every run leaves a self-contained evidence bundle (events.jsonl, result.json, summary.md, shots/, ...).
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeFile, writeJson, stamp, slug, nowIso, signature, truncate, fmtMs } from './util.mjs';

/** Verdicts, worst first. Harness-safety violations outrank everything: an invisible harness that isn't invisible is a failed harness. */
export const VERDICT_ORDER = ['FOCUS-STOLEN', 'LEAK', 'CRASH', 'HUNG', 'ERROR', 'TIMEOUT', 'FAIL', 'DIALOG', 'PASS'];
export const VERDICT_EXIT = { PASS: 0, SKIPPED: 0, FAIL: 1, ERROR: 2, TIMEOUT: 3, CRASH: 4, HUNG: 5, LEAK: 6, 'FOCUS-STOLEN': 7, DIALOG: 8 };

export function worstVerdict(list) {
  let best = 'PASS';
  for (const v of list) if (VERDICT_ORDER.indexOf(v) >= 0 && VERDICT_ORDER.indexOf(v) < VERDICT_ORDER.indexOf(best)) best = v;
  return best;
}

export class Run {
  constructor(cfg, { label = 'run', kind = 'run' } = {}) {
    this.cfg = cfg; this.kind = kind; this.label = label;
    ensureDir(cfg.outDir);
    const base = `${stamp()}-${slug(label, 40)}`;
    let dir = path.join(cfg.outDir, base), n = 1;
    while (fs.existsSync(dir)) dir = path.join(cfg.outDir, `${base}-${++n}`);
    this.dir = ensureDir(dir);
    this.name = path.basename(dir);
    this.startedAt = new Date();
    this.t0 = performance.now();
    this.findings = [];
    this.artifacts = [];
    this.meta = {};
    this.counters = {};
    this.eventsPath = path.join(dir, 'events.jsonl');
    this.fd = fs.openSync(this.eventsPath, 'a');
    this.finished = false;
  }

  now() { return Math.round(performance.now() - this.t0); }
  path(...p) { return path.join(this.dir, ...p); }
  rel(p) { return path.relative(this.dir, p).replace(/\\/g, '/'); }
  next(name) { return (this.counters[name] = (this.counters[name] || 0) + 1); }

  event(kind, data = {}) {
    if (this.finished) return;
    const rec = { t: this.now(), ts: nowIso(), kind, ...data };
    try { fs.writeSync(this.fd, JSON.stringify(rec) + '\n'); } catch { /* disk full etc: never break a run over logging */ }
    return rec;
  }

  write(rel, data) { const p = writeFile(this.path(rel), data); return p; }
  writeJson(rel, obj) { return writeJson(this.path(rel), obj); }
  artifact(kind, p, extra = {}) { this.artifacts.push({ kind, path: p, rel: this.rel(p), ...extra }); return p; }

  /** severity: error | warn | info. kind is a stable slug (ahk-error, crash, timeout, guard, dialog, ...). */
  addFinding(f) {
    const finding = { id: this.findings.length + 1, t: this.now(), severity: 'error', ...f };
    finding.signature = finding.signature || signature(`${finding.kind}: ${finding.message}`);
    this.findings.push(finding);
    this.event('finding', finding);
    return finding;
  }

  finish({ verdict, summary = '', data = {} } = {}) {
    if (this.finished) return this.result;
    const dur = this.now();
    const result = {
      run: this.name, kind: this.kind, label: this.label, verdict, summary, durationMs: dur,
      startedAt: this.startedAt.toISOString(), finishedAt: nowIso(),
      findings: this.findings, artifacts: this.artifacts, meta: this.meta, ...data,
    };
    this.result = result;
    this.event('run.end', { verdict, durationMs: dur });
    this.finished = true;
    try { fs.closeSync(this.fd); } catch { /* ignore */ }
    this.writeJson('result.json', result);
    this.write('summary.md', renderSummary(result));
    try { fs.writeFileSync(path.join(this.cfg.outDir, 'latest.txt'), this.name); } catch { /* ignore */ }
    pruneRuns(this.cfg);
    return result;
  }
}

export function renderSummary(r) {
  const L = [];
  L.push(`# ${r.verdict}  —  ${r.label}`);
  L.push('');
  if (r.summary) L.push(r.summary, '');
  L.push(`run \`${r.run}\` · ${r.kind} · ${fmtMs(r.durationMs)} · ${r.startedAt}`, '');
  const errs = r.findings.filter((f) => f.severity === 'error'), warns = r.findings.filter((f) => f.severity === 'warn'), infos = r.findings.filter((f) => f.severity === 'info');
  const groups = new Map();
  for (const f of r.findings) { const k = f.severity + '|' + f.signature; if (!groups.has(k)) groups.set(k, { f, n: 0 }); groups.get(k).n++; }
  L.push(`## Findings: ${errs.length} error · ${warns.length} warn · ${infos.length} info`, '');
  const order = { error: 0, warn: 1, info: 2 };
  for (const { f, n } of [...groups.values()].sort((a, b) => order[a.f.severity] - order[b.f.severity])) {
    const where = f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : '';
    L.push(`- **${f.severity}** \`${f.kind}\`${n > 1 ? ` ×${n}` : ''}: ${truncate(String(f.message).replace(/\s+/g, ' '), 300)}${where}${f.shot ? ` — shot: ${f.shot}` : ''}`);
  }
  if (!r.findings.length) L.push('_none_');
  const shots = r.artifacts.filter((a) => a.kind === 'shot' || a.kind === 'sheet');
  if (shots.length) { L.push('', '## Screenshots', ''); for (const s of shots.slice(0, 40)) L.push(`- ${s.rel}${s.label ? ' — ' + s.label : ''}`); }
  const others = r.artifacts.filter((a) => a.kind !== 'shot' && a.kind !== 'sheet');
  if (others.length) { L.push('', '## Artifacts', ''); for (const s of others.slice(0, 40)) L.push(`- ${s.kind}: ${s.rel}`); }
  if (r.next?.length) { L.push('', '## Suggested next', ''); for (const n of r.next) L.push(`- \`${n}\``); }
  L.push('');
  return L.join('\n');
}

export function listRuns(cfg) {
  let ents; try { ents = fs.readdirSync(cfg.outDir, { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
}

export function pruneRuns(cfg) {
  const keep = cfg.keepRuns ?? 60;
  if (!keep || keep < 0) return 0;
  const runs = listRuns(cfg);
  let n = 0;
  for (const name of runs.slice(keep)) {
    try { fs.rmSync(path.join(cfg.outDir, name), { recursive: true, force: true }); n++; } catch { /* ignore */ }
  }
  return n;
}
