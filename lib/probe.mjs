// Controller side of the in-process AhkProbe: mailbox RPC + parsing of the AHKH| stdout protocol.
import fs from 'node:fs';
import path from 'node:path';
import { sleep, ensureDir, AhkhError } from './util.mjs';

export class ProbeClient {
  constructor(session, dir) { this.session = session; this.dir = dir; this.seq = 0; }

  /** Call a probe command in the target. Needs AHKH_PROBE_MODE=rpc (session.start --probe). */
  async call(cmd, args = {}, timeoutMs = 6000) {
    const inDir = ensureDir(path.join(this.dir, 'in')); const outDir = ensureDir(path.join(this.dir, 'out'));
    const name = `${String(++this.seq).padStart(5, '0')}.json`;
    const tmp = path.join(inDir, name + '.tmp'); const req = path.join(inDir, name); const res = path.join(outDir, name);
    fs.writeFileSync(tmp, JSON.stringify({ cmd, ...args }));
    fs.renameSync(tmp, req);                      // atomic: the probe never sees half a file
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (fs.existsSync(res)) {
        let txt; try { txt = fs.readFileSync(res, 'utf8'); } catch { await sleep(10); continue; }
        try { fs.unlinkSync(res); } catch { /* ignore */ }
        const m = JSON.parse(txt.replace(/^﻿/, ''));
        if (!m.ok) { const e = new AhkhError(`probe ${cmd}: ${m.error?.message || 'error'}`, 'PROBE', { detail: m.error }); throw e; }
        return m.result;
      }
      const p = [...this.session.procs.values()].find((x) => x.name === 'main') || [...this.session.procs.values()][0];
      if (p?.exited) throw new AhkhError('target exited before answering the probe', 'PROBE');
      if (Date.now() > end) throw new AhkhError(`probe did not answer "${cmd}" within ${timeoutMs}ms (script busy, blocked, or probe not in rpc mode)`, 'PROBE_TIMEOUT');
      await sleep(25);
    }
  }
}

/** Handle one AHKH|kind|json stdout line. Returns true if it was a protocol line. */
export function handleProbeLine(session, procName, line, linemapper) {
  const m = /^AHKH\|(\w+)\|(.*)$/.exec(line);
  if (!m) return false;
  let data; try { data = JSON.parse(m[2]); } catch { data = { raw: m[2] }; }
  const kind = m[1];
  session.run.event('probe.' + kind, { proc: procName, ...data });
  const map = (file, ln) => (linemapper ? linemapper(file, ln) : { file, line: ln });
  switch (kind) {
    case 'error': {
      const w = map(data.file, data.line);
      session.addFinding({ severity: 'error', kind: 'runtime-error', proc: procName, message: `${data.message}${data.extra ? ' (' + data.extra + ')' : ''}`, file: w.file, line: w.line ?? undefined, stack: data.stack });
      break;
    }
    case 'assert': {
      if (data.ok === false) { const w = map(data.file, data.line); session.addFinding({ severity: 'error', kind: 'assertion', proc: procName, message: data.msg + (data.expected !== undefined ? ` (expected ${JSON.stringify(data.expected)}, got ${JSON.stringify(data.actual)})` : ''), file: w.file, line: w.line ?? undefined }); }
      break;
    }
    case 'step': if (data.ok === false) session.addFinding({ severity: 'error', kind: 'assertion', proc: procName, message: `step "${data.name}" failed: ${data.error?.message || ''}`, file: data.error?.file, line: data.error?.line }); break;
    case 'done': session.extra.probeDone = data; break;
    default: break;
  }
  return true;
}
