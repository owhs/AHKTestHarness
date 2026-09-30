// Verb registry: ONE definition per operation, exposed as CLI verb, MCP tool and hub RPC.
import { AhkhError } from '../util.mjs';

export const VERBS = new Map();

/**
 * def: { name, group, desc, args: { name: {type:'string'|'number'|'boolean'|'array'|'json', desc, positional?:n|'rest', required?, default?, alias?} },
 *        mcp?: false, needsSession?: true, run: async (ctx, args) => result }
 * result: { ok?, verdict?, summary, data?, images?: [paths], text?, runDir? }
 */
export function defineVerb(def) { VERBS.set(def.name, def); return def; }

export function coerce(type, v, name) {
  if (v === undefined) return v;
  switch (type) {
    case 'number': { const n = Number(v); if (Number.isNaN(n)) throw new AhkhError(`--${name} expects a number, got "${v}"`, 'BADARG'); return n; }
    case 'boolean': return v === true || v === 'true' || v === '1' || v === 'yes';
    case 'array': return Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
    case 'json': if (typeof v === 'string') { try { return JSON.parse(v); } catch { throw new AhkhError(`--${name} expects JSON`, 'BADARG'); } } return v;
    default: return Array.isArray(v) ? v[v.length - 1] : String(v);
  }
}

/** Parse argv (after the verb name) using the verb's schema. */
export function parseArgv(def, argv) {
  const schema = def.args || {};
  const byAlias = {};
  for (const [k, s] of Object.entries(schema)) { if (s.alias) byAlias[s.alias] = k; }
  const out = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') { positional.push(...argv.slice(i + 1)); break; }
    let m;
    if ((m = /^--([A-Za-z][\w-]*)(?:=(.*))?$/.exec(tok))) {
      let key = m[1]; let val = m[2];
      let neg = false;
      const camelOf = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!(key in schema) && !(camelOf(key) in schema) && key.startsWith('no-') && (camelOf(key.slice(3)) in schema || key.slice(3) in schema)) { key = key.slice(3); neg = true; }
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const name = key in schema ? key : camel in schema ? camel : key;
      const s = schema[name];
      if (!s) throw new AhkhError(`unknown option --${key} for "${def.name}" (see: ahkh help ${def.name})`, 'BADARG');
      if (s.type === 'boolean') { out[name] = neg ? false : val === undefined ? true : coerce('boolean', val, name); continue; }
      if (val === undefined) { val = argv[++i]; if (val === undefined) throw new AhkhError(`--${key} needs a value`, 'BADARG'); }
      if (s.type === 'array') {
        const got = coerce('array', val, name);
        // PowerShell turns `1,2,3` into separate args: greedy arrays swallow following non-option tokens.
        while (s.greedy && got.length < s.greedy && i + 1 < argv.length && !/^-[A-Za-z-]/.test(argv[i + 1])) got.push(String(argv[++i]).replace(/,$/, ''));
        out[name] = [...(out[name] || []), ...got];
      } else out[name] = coerce(s.type, val, name);
    } else if ((m = /^-([A-Za-z])$/.exec(tok)) && byAlias[m[1]]) {
      const name = byAlias[m[1]]; const s = schema[name];
      if (s.type === 'boolean') out[name] = true;
      else { const val = argv[++i]; if (s.type === 'array') out[name] = [...(out[name] || []), ...coerce('array', val, name)]; else out[name] = coerce(s.type, val, name); }
    } else positional.push(tok);
  }
  const pos = Object.entries(schema).filter(([, s]) => s.positional !== undefined).sort((a, b) => (a[1].positional === 'rest' ? 1e9 : a[1].positional) - (b[1].positional === 'rest' ? 1e9 : b[1].positional));
  let pi = 0;
  for (const [name, s] of pos) {
    if (s.positional === 'rest') { if (pi < positional.length) out[name] = positional.slice(pi).map((v) => coerce(s.type === 'array' ? 'string' : s.type, v, name)); pi = positional.length; }
    else if (pi < positional.length) out[name] = coerce(s.type, positional[pi++], name);
  }
  if (pi < positional.length) throw new AhkhError(`unexpected argument: ${positional[pi]}`, 'BADARG');
  return finalize(def, out);
}

/** Apply defaults + required checks to an args object (from CLI, MCP or hub). */
export function finalize(def, input) {
  const out = { ...input };
  for (const [name, s] of Object.entries(def.args || {})) {
    if (out[name] === undefined && s.default !== undefined) out[name] = s.default;
    else if (out[name] !== undefined && typeof out[name] === 'string' && s.type && s.type !== 'string') out[name] = coerce(s.type, out[name], name);
    if (s.required && (out[name] === undefined || out[name] === '' || (Array.isArray(out[name]) && !out[name].length)))
      throw new AhkhError(`missing required argument: ${name}`, 'BADARG');
  }
  return out;
}

export function jsonSchema(def) {
  const props = {}; const required = [];
  for (const [name, s] of Object.entries(def.args || {})) {
    const t = s.type === 'number' ? 'number' : s.type === 'boolean' ? 'boolean' : s.type === 'array' ? 'array' : s.type === 'json' ? undefined : 'string';
    props[name] = { ...(t ? { type: t } : {}), description: s.desc || '', ...(t === 'array' ? { items: { type: 'string' } } : {}), ...(s.default !== undefined ? { default: s.default } : {}) };
    if (s.required) required.push(name);
  }
  return { type: 'object', properties: props, ...(required.length ? { required } : {}) };
}

export function helpText(def) {
  const L = [`${def.name} — ${def.desc}`, ''];
  const pos = Object.entries(def.args || {}).filter(([, s]) => s.positional !== undefined);
  L.push(`usage: ahkh ${def.name}${pos.map(([n, s]) => (s.required ? ` <${n}>` : ` [${n}]`) + (s.positional === 'rest' ? '...' : '')).join('')} [options]`, '');
  for (const [n, s] of Object.entries(def.args || {})) {
    L.push(`  ${s.positional !== undefined ? '<' + n + '>' : '--' + n.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}${s.alias ? ' (-' + s.alias + ')' : ''}  [${s.type || 'string'}${s.default !== undefined ? ', default ' + JSON.stringify(s.default) : ''}]  ${s.desc || ''}`);
  }
  return L.join('\n');
}
