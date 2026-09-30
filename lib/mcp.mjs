// MCP server (stdio, newline-delimited JSON-RPC 2.0). Every verb becomes a tool, sessions live in-process for the life of the server.
// Register with:  claude mcp add ahkh -- node C:\projects\ahk\AHKTestHarness\bin\ahkh.mjs mcp     (or bun)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { VERBS, finalize, jsonSchema } from './verbs/registry.mjs';
import './verbs/index.mjs';
import { makeContext } from './cli.mjs';
import { HARNESS_ROOT, truncate, readText, exists } from './util.mjs';
import { listRuns } from './evidence.mjs';

const PROTOCOL = '2024-11-05';
const toolName = (verb) => 'ahkh_' + verb.replace(/\./g, '_');
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

export async function serveMcp({ cwd, project } = {}) {
  const ctx = makeContext({ cwd: cwd || process.cwd(), project });
  ctx.isMcp = true;
  const byTool = new Map();
  for (const def of VERBS.values()) if (def.mcp !== false && def.group !== 'internal') byTool.set(toolName(def.name), def);

  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const tools = () => [...byTool].map(([name, def]) => {
    const schema = jsonSchema(def);
    schema.properties.verbose = { type: 'boolean', description: 'also return the full structured result as JSON' };
    return { name, description: `[${def.group}] ${def.desc}`, inputSchema: schema };
  });

  async function callTool(name, args) {
    const def = byTool.get(name);
    if (!def) throw new Error(`unknown tool ${name}`);
    const { verbose, ...rest } = args || {};
    const a = finalize(def, rest);
    let res;
    try { res = await def.run(ctx, a); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] }; }
    const content = [];
    const text = [res.summary, res.text].filter(Boolean).join('\n');
    content.push({ type: 'text', text: text || (res.ok === false ? 'failed' : 'ok') });
    for (const img of (res.images || []).slice(0, 4)) {
      try {
        const st = fs.statSync(img);
        if (st.size <= MAX_IMAGE_BYTES) content.push({ type: 'image', data: fs.readFileSync(img).toString('base64'), mimeType: 'image/png' });
        else content.push({ type: 'text', text: `(image too large to inline: ${img})` });
      } catch { /* missing */ }
    }
    if (verbose && res.data !== undefined) content.push({ type: 'text', text: truncate(JSON.stringify(res.data, null, 1), 30000) });
    const bad = res.ok === false || (res.verdict && !['PASS', 'SKIPPED'].includes(res.verdict) && res.verdict !== undefined && ['ERROR', 'CRASH', 'HUNG', 'LEAK', 'FOCUS-STOLEN', 'TIMEOUT'].includes(res.verdict));
    return { content, isError: !!bad && res.ok === false };
  }

  const resources = () => {
    const list = [{ uri: 'ahkh://guide', name: 'ahkh agent guide', mimeType: 'text/markdown', description: 'How to use the ahkh harness effectively' }];
    const runs = listRuns(ctx.cfg).slice(0, 10);
    for (const r of runs) list.push({ uri: `ahkh://run/${r}`, name: `run ${r}`, mimeType: 'text/markdown', description: 'summary.md of a recent run' });
    return list;
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const { id, method, params } = m;
    try {
      switch (method) {
        case 'initialize': return reply(id, { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'ahkh', version: '0.1.0' }, instructions: 'Hidden-desktop test harness. Start with ahkh_doctor. For one-shot checks use ahkh_run / ahkh_lsp_check; for GUIs use ahkh_session_start then shot/tree/click/press/type/wait, then ahkh_session_stop. Nothing appears on the user\'s screen.' });
        case 'notifications/initialized': case 'notifications/cancelled': return;
        case 'ping': return reply(id, {});
        case 'tools/list': return reply(id, { tools: tools() });
        case 'tools/call': return reply(id, await callTool(params.name, params.arguments));
        case 'resources/list': return reply(id, { resources: resources() });
        case 'resources/read': {
          const uri = params.uri; let text = '';
          if (uri === 'ahkh://guide') text = readText(path.join(HARNESS_ROOT, 'AGENTS.md'));
          else { const n = uri.replace('ahkh://run/', ''); const f = path.join(ctx.cfg.outDir, n, 'summary.md'); text = exists(f) ? readText(f) : 'not found'; }
          return reply(id, { contents: [{ uri, mimeType: 'text/markdown', text }] });
        }
        case 'prompts/list': return reply(id, { prompts: [] });
        default: if (id !== undefined) return fail(id, -32601, `method not found: ${method}`);
      }
    } catch (e) { if (id !== undefined) fail(id, -32000, e.message); }
  });
  rl.on('close', async () => { for (const s of ctx.sessions.values()) { try { await s.close({ summary: 'mcp closed' }); } catch { /* ignore */ } } await ctx.dispose?.(); process.exit(0); });
  await new Promise(() => {});
}
