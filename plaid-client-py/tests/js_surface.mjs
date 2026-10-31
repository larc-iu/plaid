// The JS client's public surface, as JSON, for test_surface.py to hold the
// Python client's to: the root exports, the client's own methods (static and
// instance), and each resource bundle's methods. Names are as JS spells them.
// `params` gives each method's parameters, keyed as the bundle method is
// named in test_surface.py (`bundle.method`, or the bare name for the
// client's own): `positional`, the names of the plain parameters in order,
// `options`, the keys of every destructured object parameter, and `bags`, a
// plain parameter named `options` or `opts` with the keys the body reads off
// it (`options.limit`, `options?.document`).
import { pathToFileURL } from 'node:url';

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

function params(f) {
  const s = f.toString();
  const open = s.indexOf('(');
  const arrow = s.indexOf('=>');
  let list;
  let end;
  if (arrow >= 0 && (open < 0 || arrow < open)) {
    const p = s.slice(0, arrow).replace(/^async\s+/, '').trim();
    list = p ? [p] : [];
    end = arrow;
  } else {
    [list, end] = splitTop(s, open + 1);
  }
  const body = s.slice(end);
  const out = { positional: [], options: [], bags: {} };
  for (const p of list) {
    if (p.startsWith('{')) out.options.push(...splitTop(p, 1)[0].map(nameOf));
    else {
      const name = nameOf(p);
      out.positional.push(name);
      if (name === 'options' || name === 'opts') {
        const read = new RegExp(`\\b${name}\\??\\.([A-Za-z_$][\\w$]*)`, 'g');
        const keys = [...body.matchAll(read)].map((m) => m[1]);
        out.bags[name] = [...new Set(keys)];
      }
    }
  }
  return out;
}

const bundles = {};
const methods = [];
const sigs = {};
for (const [k, v] of Object.entries(client)) {
  if (k.startsWith('_')) continue;
  if (typeof v === 'function') {
    methods.push(k);
    sigs[k] = params(v);
  } else if (isBundle(v)) {
    bundles[k] = Object.keys(v).filter((n) => typeof v[n] === 'function');
    for (const n of bundles[k]) sigs[`${k}.${n}`] = params(v[n]);
  }
}
for (const n of Object.getOwnPropertyNames(Object.getPrototypeOf(client)))
  if (n !== 'constructor' && !n.startsWith('_') && typeof client[n] === 'function') {
    methods.push(n);
    sigs[n] = params(client[n]);
  }
for (const n of Object.getOwnPropertyNames(mod.PlaidClient))
  if (typeof mod.PlaidClient[n] === 'function') {
    methods.push(n);
    sigs[n] = params(mod.PlaidClient[n]);
  }
process.stdout.write(
  JSON.stringify({
    exports: Object.keys(mod).filter((n) => n !== 'default'),
    methods,
    bundles,
    params: sigs,
  }),
);
