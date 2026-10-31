// The JS client's public surface, as JSON, for test_surface.py to hold the
// Python client's to: the root exports, the client's own methods (static and
// instance), and each resource bundle's methods. Names are as JS spells them.
// `params` gives each method's parameters, keyed as the bundle method is
// named in test_surface.py (`bundle.method`, or the bare name for the
// client's own, and `constructor`): `positional`, the names of the plain
// parameters in order, `options`, the keys of every destructured object
// parameter, and `bags`, a plain parameter named `options` or `opts` with the
// keys read off it: in the method's own body (`options.limit`,
// `options?.document`), and in every function of the client's source it is
// handed to whole (`configRequest(auditMessage, value, options)`,
// `new PlaidClient(baseUrl, token, options)`), followed as far as it goes.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(process.argv[2]).href);
const client = new mod.PlaidClient('http://x', 't');
const isBundle = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some((f) => typeof f === 'function');

/** `s` split at its commas outside brackets and quotes, from `from` to the
 *  bracket that closes the list (or the end). Answers [parts, end]. */
function splitTop(s, from) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = from;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      const close = s.indexOf(s[i + 1] === '/' ? '\n' : '*/', i + 2);
      i = close < 0 ? s.length : close;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (depth === 0) {
        parts.push(s.slice(start, i));
        return [parts.map((p) => p.trim()).filter(Boolean), i];
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return [parts.map((p) => p.trim()).filter(Boolean), s.length];
}

const nameOf = (p) => p.replace(/^\.\.\./, '').split('=')[0].split(':')[0].trim();

/** The parameter list of the function whose source starts `s` (a method, an
 *  arrow or a `function`), and the source after the list. */
function header(s) {
  const open = s.indexOf('(');
  const arrow = s.indexOf('=>');
  if (arrow >= 0 && (open < 0 || arrow < open)) {
    const p = s.slice(0, arrow).replace(/^async\s+/, '').trim();
    return [p ? [p] : [], s.slice(arrow)];
  }
  const [list, end] = splitTop(s, open + 1);
  return [list, s.slice(end + 1)];
}

/** The body of a function declared in a source file: from its first `{` to
 *  the brace that closes it. */
function bodyOf(rest) {
  const open = rest.indexOf('{');
  return rest.slice(0, splitTop(rest, open + 1)[1] + 1);
}

// Every function the client's source declares at the top of a file, and the
// constructor of PlaidClient, by name: its parameter list and body.
const FUNCS = {};
const srcDir = dirname(fileURLToPath(pathToFileURL(process.argv[2]).href));
for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(join(srcDir, file), 'utf8');
  for (const m of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const [list, rest] = header(text.slice(m.index + m[0].length - 1));
    FUNCS[m[1]] = { list, body: bodyOf(rest) };
  }
}
{
  const cls = mod.PlaidClient.toString();
  const at = cls.search(/\bconstructor\s*\(/);
  const [list, rest] = header(cls.slice(at + 'constructor'.length));
  FUNCS.constructor = { list, body: bodyOf(rest) };
}

/** The keys read off `name` in `body`, and in every function of FUNCS it is
 *  handed to whole, by the parameter it lands on there. */
function keysOf(body, name, seen = new Set()) {
  const keys = new Set(
    [...body.matchAll(new RegExp(`\\b${name}\\??\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1]),
  );
  for (const m of body.matchAll(/(new\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const callee = m[1] ? (m[2] === 'PlaidClient' ? 'constructor' : null) : m[2];
    const def = Object.hasOwn(FUNCS, callee ?? '') ? FUNCS[callee] : null;
    if (!def) continue;
    const at = splitTop(body, m.index + m[0].length)[0].indexOf(name);
    const param = def.list[at];
    if (at < 0 || !param || seen.has(`${callee}:${at}`)) continue;
    seen.add(`${callee}:${at}`);
    if (param.startsWith('{')) splitTop(param, 1)[0].forEach((k) => keys.add(nameOf(k)));
    else keysOf(def.body, nameOf(param), seen).forEach((k) => keys.add(k));
  }
  return [...keys];
}

function params(list, body) {
  const out = { positional: [], options: [], bags: {} };
  for (const p of list) {
    if (p.startsWith('{')) out.options.push(...splitTop(p, 1)[0].map(nameOf));
    else {
      const name = nameOf(p);
      out.positional.push(name);
      if (name === 'options' || name === 'opts') out.bags[name] = keysOf(body, name);
    }
  }
  return out;
}

const paramsOf = (f) => params(...header(f.toString()));

const bundles = {};
const methods = [];
const sigs = {};
for (const [k, v] of Object.entries(client)) {
  if (k.startsWith('_')) continue;
  if (typeof v === 'function') {
    methods.push(k);
    sigs[k] = paramsOf(v);
  } else if (isBundle(v)) {
    bundles[k] = Object.keys(v).filter((n) => typeof v[n] === 'function');
    for (const n of bundles[k]) sigs[`${k}.${n}`] = paramsOf(v[n]);
  }
}
for (const n of Object.getOwnPropertyNames(Object.getPrototypeOf(client)))
  if (n !== 'constructor' && !n.startsWith('_') && typeof client[n] === 'function') {
    methods.push(n);
    sigs[n] = paramsOf(client[n]);
  }
for (const n of Object.getOwnPropertyNames(mod.PlaidClient))
  if (typeof mod.PlaidClient[n] === 'function') {
    methods.push(n);
    sigs[n] = paramsOf(mod.PlaidClient[n]);
  }
sigs.constructor = params(FUNCS.constructor.list, FUNCS.constructor.body);
process.stdout.write(
  JSON.stringify({
    exports: Object.keys(mod).filter((n) => n !== 'default'),
    methods,
    bundles,
    params: sigs,
  }),
);
