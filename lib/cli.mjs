// CLI front-end: ahkh <verb> [args] [--json] [--project file] [--out dir]
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { VERBS, parseArgv, helpText } from './verbs/registry.mjs';
import './verbs/index.mjs';
import { AhkhError, runtimeName } from './util.mjs';
import { VERDICT_EXIT } from './evidence.mjs';
import { hubCall, hubAvailable } from './hub.mjs';

export function makeContext({ cwd = process.cwd(), project = null, overrides = {} } = {}) {
  const cfg = loadConfig({ cwd, project, overrides });
  return { cfg, cwd, sessions: new Map(), state: {} };
}

function extractGlobals(argv) {
  const g = { json: false, project: null, out: null, hub: false, session: null, quiet: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') g.json = true;
    else if (t === '--quiet') g.quiet = true;
    else if (t === '--hub') g.hub = true;
    else if (t === '--project') g.project = argv[++i];
    else if (t === '--out') g.out = argv[++i];
    else if (t === '-s' || t === '--session') g.session = argv[++i];
    else rest.push(t);
  }
  return { g, rest };
}

export function overviewText() {
  const groups = new Map();
  for (const v of VERBS.values()) { if (!groups.has(v.group)) groups.set(v.group, []); groups.get(v.group).push(v); }
  const L = [`ahkh — generic AutoHotkey v2 / GUI test harness  (${runtimeName})`, '', 'usage: ahkh <verb> [args] [--json] [--project ahkh.json] [--out dir] [-s session]', ''];
  for (const [g, vs] of groups) { L.push(`${g}:`); for (const v of vs) L.push(`  ${v.name.padEnd(14)} ${v.desc}`); L.push(''); }
  L.push('ahkh help <verb> for details.  Runs are written to <project>/.ahkh/runs (or outDir).');
  return L.join('\n');
}

export async function main(argv) {
  const { g, rest } = extractGlobals(argv);
  const verbName = rest.shift();
  if (!verbName || verbName === 'help' || verbName === '--help' || verbName === '-h') {
    const v = rest[0] && VERBS.get(rest[0]);
    console.log(v ? helpText(v) : overviewText());
    return 0;
  }
  if (verbName === 'version' || verbName === '--version') { console.log(`ahkh 0.1.0 (${runtimeName})`); return 0; }
  const def = VERBS.get(verbName);
  if (!def) { console.error(`unknown verb "${verbName}". Try: ahkh help`); return 64; }
  let result;
  try {
    const args = parseArgv(def, rest);
    const overrides = g.out ? { outDir: g.out } : {};
    const useHub = (g.session || g.hub || def.needsHub) && !def.local;
    if (useHub) {
      const ctxLite = makeContext({ project: g.project, overrides });
      if (g.session) args.session = g.session;
      result = await hubCall(ctxLite, verbName, args, { spawn: def.name === 'session.start' });
    } else {
      const ctx = makeContext({ project: g.project, overrides });
      result = await def.run(ctx, args);
      await ctx.dispose?.();
    }
  } catch (e) {
    const msg = e instanceof AhkhError ? e.message : (e.stack || e.message);
    if (g.json) console.log(JSON.stringify({ ok: false, error: e.message, code: e.code || 'ERROR' }));
    else console.error(`error: ${msg}`);
    return e.code === 'BADARG' ? 64 : 70;
  }
  if (g.json) console.log(JSON.stringify(result, null, 2));
  else if (!g.quiet) {
    if (result.summary) console.log(result.summary);
    if (result.text) console.log(result.text);
    if (result.images?.length) console.log('images: ' + result.images.join('\n        '));
  }
  if (result.exitCode != null) return result.exitCode;
  if (result.verdict) return VERDICT_EXIT[result.verdict] ?? 1;
  return result.ok === false ? 1 : 0;
}

export { path };
