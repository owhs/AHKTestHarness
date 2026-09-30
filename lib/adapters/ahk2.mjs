// AutoHotkey v2 adapter: find the interpreter, build the command line, turn AHK's text output into findings.
import path from 'node:path';
import { findAhk, readRequires } from '../config.mjs';
import { AhkhError, exists, readText, truncate } from '../util.mjs';

export function resolveAhk(cfg, script, { bits } = {}) {
  const requires = script ? readRequires(script) : '';
  if (/^AutoHotkey\s+v?1\b/i.test(requires)) throw new AhkhError(`${script}: #Requires ${requires} — this harness targets AutoHotkey v2`, 'AHKV1');
  const exe = findAhk(cfg, { requires, bits });
  if (!exe) throw new AhkhError('AutoHotkey v2 not found (set ahk.exe in ahkh.json or AHKH_AHK)', 'NOAHK');
  return { exe, requires };
}

/** Command-line args for an AHK v2 run. */
export function ahkArgs({ script, scriptArgs = [], validate = false, includes = [], extra = [], errStdOut = true }) {
  const a = [];
  if (errStdOut) a.push('/ErrorStdOut=UTF-8');
  if (validate) a.push('/Validate');
  for (const inc of includes) a.push('/include', inc);
  a.push(...extra);
  a.push(script, ...scriptArgs);
  return a;
}

/**
 * Parse AHK load/validate output. v2 prints:
 *   C:\path\file.ahk (12) : ==> Some message
 *        Specifically: text
 * Returns [{file,line,message,specifically,warning}].
 */
export function parseAhkOutput(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(.*?) \((\d+)\) : ==> (.*)$/.exec(lines[i]);
    if (!m) continue;
    const rec = { file: m[1], line: Number(m[2]), message: m[3].trim(), specifically: '' };
    const nxt = lines[i + 1] || '';
    const sp = /^\s*Specifically:\s*(.*)$/.exec(nxt);
    if (sp) { rec.specifically = sp[1].trim(); i++; }
    rec.warning = /^Warning\b/i.test(rec.message);
    out.push(rec);
  }
  return out;
}

/** Map an effective-script line back to the original using a linemap {file: [origLine|null,...]}. */
export function mapLine(linemap, file, line) {
  if (!linemap || !file) return { file, line };
  const key = Object.keys(linemap).find((k) => path.resolve(k).toLowerCase() === path.resolve(file).toLowerCase());
  if (!key) return { file, line };
  const orig = linemap[key].orig || key;
  const arr = linemap[key].lines;
  const mapped = arr ? arr[line - 1] : line;
  return { file: orig, line: mapped ?? null, injected: mapped == null };
}

/** After a process exits, turn AHK's load-time text into findings (idempotent per process). */
export function harvestAhkText(session, procName, { linemap } = {}) {
  const p = session.proc(procName);
  if (p._harvested) return 0;
  p._harvested = true;
  const text = [...p.out, ...p.err].join('\n');
  const recs = parseAhkOutput(text);
  for (const r of recs) {
    const mapped = mapLine(linemap, r.file, r.line);
    session.addFinding({
      severity: r.warning ? 'warn' : 'error', kind: r.warning ? 'ahk-warning' : 'load-error', proc: procName,
      message: r.specifically ? `${r.message} — ${r.specifically}` : r.message, file: mapped.file, line: mapped.line ?? undefined,
    });
  }
  return recs.length;
}

/** Unhandled-error text that reached stdout/stderr (e.g. printed by a probe OnError handler): "AHKH-ERROR|file|line|message". */
export function harvestProbeErrors(session, procName) {
  const p = session.proc(procName);
  let n = 0;
  for (const line of [...p.out, ...p.err]) {
    const m = /^AHKH-ERROR\|(.*?)\|(\d*)\|(.*)$/.exec(line);
    if (m) { session.addFinding({ severity: 'error', kind: 'runtime-error', proc: procName, message: m[3], file: m[1], line: m[2] ? Number(m[2]) : undefined }); n++; }
  }
  return n;
}

export function scriptNameOf(script) { return path.basename(script); }
export function assertScript(script) { if (!script || !exists(script)) throw new AhkhError(`script not found: ${script}`, 'NOSCRIPT'); return path.resolve(script); }
export function preview(script, n = 400) { try { return truncate(readText(script), n); } catch { return ''; } }
