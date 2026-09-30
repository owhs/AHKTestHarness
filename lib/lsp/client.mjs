// Headless client for the thqby AutoHotkey v2 language server.
//
// The server (node) runs INSIDE the hidden desktop (launched through the native host) and connects back to us over a
// localhost socket (`--socket=PORT`, vscode-languageserver's client-listens transport). So neither the server nor the AutoHotkey
// interpreter it spawns to read A_* variables can ever show a window on the user's screen.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HostClient } from '../host.mjs';
import { findLspExtension, findNode, findAhk } from '../config.mjs';
import { AhkhError, sleep, ensureDir, exists, readText, shortId } from '../util.mjs';

export function pathToUri(p) {
  let s = path.resolve(p).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) s = '/' + s[0].toLowerCase() + ':' + s.slice(2);
  const enc = s.split('').map((ch) => (/[A-Za-z0-9\-._~/]/.test(ch) ? ch : ch === ':' ? '%3A' : [...Buffer.from(ch, 'utf8')].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''))).join('');
  return 'file://' + enc;
}

export function uriToPath(u) {
  let s = decodeURIComponent(u.replace(/^file:\/\//i, ''));
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  return path.normalize(s);
}

const SEV = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

export class LspClient {
  constructor(cfg, { log } = {}) {
    this.cfg = cfg; this.log = log || (() => {});
    this.pending = new Map(); this.nextId = 1; this.buf = Buffer.alloc(0);
    this.diags = new Map();            // uri -> {list, at, version}
    this.opened = new Map();           // uri -> version
    this.serverLog = [];
    this.lastPublishAt = 0;
    this.ready = false;
  }

  async start({ rootDir } = {}) {
    const ext = findLspExtension(this.cfg);
    if (!ext) throw new AhkhError('thqby.vscode-autohotkey2-lsp not found. Install it in VS Code (or set lsp.extension in ahkh.json / AHKH_LSP).', 'NOLSP');
    const node = findNode(this.cfg);
    if (!node) throw new AhkhError('node.exe not found (the language server needs node)', 'NONODE');
    this.ext = ext; this.node = node;
    const server = path.join(ext, 'server', 'dist', 'server.js');
    // 1. we listen; the server connects (client-listens socket transport)
    const connected = new Promise((resolve, reject) => {
      this.tcp = net.createServer((sock) => { this.sock = sock; sock.on('data', (d) => this._data(d)); sock.on('error', () => {}); sock.on('close', () => { this.closed = true; for (const [, p] of this.pending) p.reject(new AhkhError('language server closed', 'LSPDEAD')); this.pending.clear(); }); resolve(); });
      this.tcp.on('error', reject);
      this.tcp.listen(0, '127.0.0.1');
    });
    await new Promise((r) => this.tcp.once('listening', r));
    const port = this.tcp.address().port;
    // 2. launch the server inside the hidden desktop
    if (this.cfg.lsp?.direct) {
      const { spawn } = await import('node:child_process');
      this.child = spawn(node, [server, `--socket=${port}`, `--clientProcessId=${process.pid}`], { cwd: ext, windowsHide: true, stdio: 'ignore' });
    } else {
      this.host = new HostClient({ exe: this.cfg.hostExe });
      await this.host.start();
      const logDir = ensureDir(path.join(os.tmpdir(), 'ahkh-lsp-' + shortId(3)));
      this.logDir = logDir;
      await this.host.request('proc.start', { proc: 'lsp', exe: node, args: `"${server}" --socket=${port} --clientProcessId=${process.pid}`, cwd: ext, stdout: path.join(logDir, 'out.txt'), stderr: path.join(logDir, 'err.txt'), show: 'hidden', memMb: 3072 });
    }
    await Promise.race([connected, sleep(15000).then(() => { throw new AhkhError('language server did not connect within 15s', 'LSPTIMEOUT'); })]);
    // 3. initialize
    const root = rootDir ? path.resolve(rootDir) : process.cwd();
    const ahk = findAhk(this.cfg);
    const settings = {
      locale: 'en-us', InterpreterPath: ahk || '', ActionWhenV1IsDetected: 'Continue', AutoLibInclude: 'Disabled', ExplicitContextOnly: false,
      Warn: { VarUnset: true, Unused: false, LocalSameAsGlobal: false, CallWithoutParentheses: 'Off' },
      Diagnostics: { ClassNonDynamicMemberCheck: true, InvokeCheck: ['ParamCount'] },
      Files: { Exclude: [], MaxDepth: 2 }, WorkingDirs: [],
    };
    const merged = deepMerge(settings, this.cfg.lsp?.settings || {});
    this.settings = merged;
    const res = await this.request('initialize', {
      processId: process.pid, clientInfo: { name: 'ahkh', version: '0.1.0' }, rootUri: pathToUri(root), rootPath: root,
      workspaceFolders: [{ uri: pathToUri(root), name: path.basename(root) }],
      initializationOptions: merged,
      capabilities: {
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false }, publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true }, definition: { linkSupport: true }, hover: { contentFormat: ['plaintext', 'markdown'] },
          completion: { completionItem: { snippetSupport: false } }, references: {}, signatureHelp: {}, formatting: {}, rename: { prepareSupport: true },
          semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] },
        },
        workspace: { workspaceFolders: true, symbol: {} },
      },
    }, 30000);
    this.capabilities = res.capabilities;
    this.notify('initialized', {});
    this.ready = true;
    return res;
  }

  // ---------------------------------------------------------------- transport
  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const i = this.buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, i).toString('ascii'));
      if (!m) { this.buf = this.buf.slice(i + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < i + 4 + len) return;
      const body = this.buf.slice(i + 4, i + 4 + len).toString('utf8');
      this.buf = this.buf.slice(i + 4 + len);
      let msg; try { msg = JSON.parse(body); } catch { continue; }
      this._msg(msg);
    }
  }

  _send(obj) {
    if (!this.sock || this.closed) throw new AhkhError('language server not connected', 'LSPDEAD');
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.sock.write(`Content-Length: ${body.length}\r\n\r\n`); this.sock.write(body);
  }

  request(method, params, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new AhkhError(`LSP ${method} timed out after ${timeoutMs}ms`, 'LSPTIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try { this._send({ jsonrpc: '2.0', id, method, params }); } catch (e) { clearTimeout(t); this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params) { this._send({ jsonrpc: '2.0', method, params }); }

  _msg(m) {
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && this.pending.has(m.id)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.error) p.reject(new AhkhError(`LSP error ${m.error.code}: ${m.error.message}`, 'LSPERR')); else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) {   // server -> client request: always answer (null), never leave the server waiting
      try { this._send({ jsonrpc: '2.0', id: m.id, result: null }); } catch { /* gone */ }
      this.serverLog.push(`[request] ${m.method}`);
      return;
    }
    switch (m.method) {
      case 'textDocument/publishDiagnostics': {
        const { uri, diagnostics, version } = m.params;
        this.diags.set(uri, { list: diagnostics || [], at: Date.now(), version, seq: (this.diags.get(uri)?.seq || 0) + 1 });
        this.lastPublishAt = Date.now();
        break;
      }
      case 'window/logMessage': case 'window/showMessage': this.serverLog.push(`[${m.method}] ${m.params?.message}`); if (this.serverLog.length > 500) this.serverLog.shift(); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- documents
  async open(file, text) {
    const uri = pathToUri(file);
    text = text ?? readText(file);
    if (this.opened.has(uri)) { this.notify('textDocument/didClose', { textDocument: { uri } }); this.diags.delete(uri); }   // didClose->didOpen forces a fresh publish
    const version = (this.opened.get(uri) || 0) + 1;
    this.opened.set(uri, version);
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'ahk2', version, text } });
    return uri;
  }

  close(file) { const uri = pathToUri(file); if (this.opened.has(uri)) { this.notify('textDocument/didClose', { textDocument: { uri } }); this.opened.delete(uri); } }

  /**
   * Diagnostics for a file. The server computes semantic diagnostics lazily (during documentSymbol), debounces publishing by 500ms,
   * and a clean file never publishes at all - so: open, ask for symbols, then wait for the publishes to settle.
   */
  async diagnostics(file, { settleMs = 900, maxWaitMs = 8000, text } = {}) {
    const uri = await this.open(file, text);
    const t0 = Date.now();
    try { await this.request('textDocument/documentSymbol', { textDocument: { uri } }, maxWaitMs); } catch (e) { this.serverLog.push('documentSymbol failed: ' + e.message); }
    let lastSeq = -1, quietSince = Date.now();
    for (;;) {
      const d = this.diags.get(uri);
      const seq = d ? d.seq : 0;
      if (seq !== lastSeq) { lastSeq = seq; quietSince = Date.now(); }
      if (Date.now() - quietSince >= settleMs) break;
      if (Date.now() - t0 > maxWaitMs) break;
      await sleep(40);
    }
    const src = (text ?? readText(file)).split(/\r?\n/);
    const list = (this.diags.get(uri)?.list || []).map((d) => normalizeDiag(d, file, src));
    return { file, diagnostics: list, published: this.diags.has(uri), ms: Date.now() - t0 };
  }

  async symbols(file) { const uri = await this.open(file); return this.request('textDocument/documentSymbol', { textDocument: { uri } }); }
  async at(kind, file, line, col, extra = {}) { const uri = await this.open(file); await this.request('textDocument/documentSymbol', { textDocument: { uri } }).catch(() => {}); return this.request(kind, { textDocument: { uri }, position: { line: line - 1, character: col - 1 }, ...extra }); }
  definition(file, line, col) { return this.at('textDocument/definition', file, line, col); }
  references(file, line, col) { return this.at('textDocument/references', file, line, col, { context: { includeDeclaration: true } }); }
  hover(file, line, col) { return this.at('textDocument/hover', file, line, col); }
  completion(file, line, col) { return this.at('textDocument/completion', file, line, col, { context: { triggerKind: 1 } }); }
  signature(file, line, col) { return this.at('textDocument/signatureHelp', file, line, col); }
  async rename(file, line, col, newName) { return this.at('textDocument/rename', file, line, col, { newName }); }
  async format(file, { tabSize = 4, insertSpaces = true } = {}) { const uri = await this.open(file); return this.request('textDocument/formatting', { textDocument: { uri }, options: { tabSize, insertSpaces } }); }
  workspaceSymbols(query) { return this.request('workspace/symbol', { query }); }
  custom(method, params) { return this.request(method, params); }

  async stop() {
    try { if (this.ready && !this.closed) { await this.request('shutdown', null, 3000).catch(() => {}); this.notify('exit', null); } } catch { /* ignore */ }
    try { this.sock?.destroy(); } catch { /* ignore */ }
    try { this.tcp?.close(); } catch { /* ignore */ }
    try { this.child?.kill(); } catch { /* ignore */ }
    if (this.host) await this.host.close();
    this.ready = false;
  }
}

export function normalizeDiag(d, file, srcLines) {
  const line = d.range.start.line + 1;
  return {
    file, line, col: d.range.start.character + 1, endLine: d.range.end.line + 1, endCol: d.range.end.character + 1,
    severity: SEV[d.severity] || 'error', code: d.code ?? null, source: d.source || 'ahk2', message: d.message,
    sourceLine: srcLines[line - 1] ?? '', tags: d.tags || [], data: d.data,
  };
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const o = { ...a };
  for (const k of Object.keys(b)) o[k] = (a && typeof a[k] === 'object' && !Array.isArray(a[k])) ? deepMerge(a[k], b[k]) : b[k];
  return o;
}

export function symbolKindName(k) {
  return ['', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'][k] || String(k);
}
