// Hub: a small local daemon that keeps sessions (hidden desktops, launched apps) and warm LSP servers alive between CLI calls,
// so an agent can drive an app step by step:  ahkh session.start --script x.ahk ; ahkh shot ; ahkh click "button:OK" ; ...
// Protocol: newline-delimited JSON over 127.0.0.1:<port>, guarded by a random token stored in <root>/.ahkh/hub.json.
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AhkhError, ensureDir, readJson, shortId, sleep, exists, HARNESS_ROOT } from './util.mjs';
import { VERBS, finalize } from './verbs/registry.mjs';
import { loadConfig } from './config.mjs';

const hubFile = (cfg) => path.join(cfg.root, '.ahkh', 'hub.json');

function tryConnect(info, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: info.port });
    const t = setTimeout(() => { sock.destroy(); resolve(null); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', () => { clearTimeout(t); resolve(null); });
  });
}

export function hubAvailable(cfg) { return exists(hubFile(cfg)); }

async function ensureHub(cfg, { spawnIfMissing }) {
  let info = readJson(hubFile(cfg), null);
  if (info) { const s = await tryConnect(info); if (s) { s.destroy(); return info; } try { fs.unlinkSync(hubFile(cfg)); } catch { /* stale */ } }
  if (!spawnIfMissing) throw new AhkhError('no ahkh hub running. Start a session first: ahkh session.start ...', 'NOHUB');
  ensureDir(path.join(cfg.root, '.ahkh'));
  const rt = process.execPath;
  const child = spawn(rt, [path.join(HARNESS_ROOT, 'bin', 'ahkh.mjs'), 'hub.serve', ...(cfg.projectFile ? ['--project', cfg.projectFile] : [])],
    { detached: true, stdio: 'ignore', windowsHide: true, cwd: cfg.root });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    info = readJson(hubFile(cfg), null);
    if (info) { const s = await tryConnect(info); if (s) { s.destroy(); return info; } }
  }
  throw new AhkhError('hub failed to start', 'NOHUB');
}

/** Client side: run a verb inside the hub process. */
export async function hubCall(ctxLite, verb, args, { spawn: spawnIfMissing = false, timeoutMs = 600000 } = {}) {
  const cfg = ctxLite.cfg;
  const info = await ensureHub(cfg, { spawnIfMissing });
  const sock = await tryConnect(info);
  if (!sock) throw new AhkhError('cannot reach hub', 'NOHUB');
  return new Promise((resolve, reject) => {
    const id = shortId(3);
    const rl = readline.createInterface({ input: sock });
    const timer = setTimeout(() => { sock.destroy(); reject(new AhkhError(`hub call timed out: ${verb}`, 'TIMEOUT')); }, timeoutMs);
    rl.on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id !== id) return;
      clearTimeout(timer); sock.end();
      if (m.ok) resolve(m.result); else reject(new AhkhError(m.error, m.code || 'HUBERR'));
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(new AhkhError('hub connection error: ' + e.message, 'NOHUB')); });
    sock.write(JSON.stringify({ id, token: info.token, verb, args }) + '\n');
  });
}

/** Server side: ahkh hub.serve */
export async function serveHub(makeCtx, { idleMinutes = 90 } = {}) {
  const ctx = makeCtx();
  const cfg = ctx.cfg;
  const token = shortId(12);
  let lastCall = Date.now();
  const server = net.createServer((sock) => {
    const rl = readline.createInterface({ input: sock });
    rl.on('line', async (line) => {
      let req; try { req = JSON.parse(line); } catch { return; }
      const reply = (o) => { try { sock.write(JSON.stringify({ id: req.id, ...o }) + '\n'); } catch { /* client gone */ } };
      if (req.token !== token) return reply({ ok: false, error: 'bad token', code: 'AUTH' });
      lastCall = Date.now();
      const def = VERBS.get(req.verb);
      if (!def) return reply({ ok: false, error: `unknown verb ${req.verb}` });
      try { const args = finalize(def, req.args || {}); const result = await def.run(ctx, args); reply({ ok: true, result }); }
      catch (e) { reply({ ok: false, error: e.message, code: e.code }); }
      lastCall = Date.now();
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  ensureDir(path.join(cfg.root, '.ahkh'));
  fs.writeFileSync(hubFile(cfg), JSON.stringify({ port, token, pid: process.pid, started: new Date().toISOString(), root: cfg.root }));
  const shutdown = async () => {
    try { fs.unlinkSync(hubFile(cfg)); } catch { /* ignore */ }
    for (const s of ctx.sessions.values()) { try { await s.close({ summary: 'hub shutdown' }); } catch { /* ignore */ } }
    await ctx.dispose?.();
    server.close(); process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  ctx.hubShutdown = shutdown;
  setInterval(() => { if (Date.now() - lastCall > idleMinutes * 60000) shutdown(); }, 30000).unref();
  await new Promise(() => {});
}
