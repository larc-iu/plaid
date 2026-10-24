// The JS client's public surface, as JSON, for test_surface.py to hold the
// Python client's to: the root exports, the client's own methods (static and
// instance), and each resource bundle's methods. Names are as JS spells them.
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(process.argv[2]).href);
const client = new mod.PlaidClient('http://x', 't');
const isBundle = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some((f) => typeof f === 'function');
const bundles = {};
const methods = [];
for (const [k, v] of Object.entries(client)) {
  if (k.startsWith('_')) continue;
  if (typeof v === 'function') methods.push(k);
  else if (isBundle(v)) bundles[k] = Object.keys(v).filter((n) => typeof v[n] === 'function');
}
for (const n of Object.getOwnPropertyNames(Object.getPrototypeOf(client)))
  if (n !== 'constructor' && !n.startsWith('_') && typeof client[n] === 'function') methods.push(n);
for (const n of Object.getOwnPropertyNames(mod.PlaidClient))
  if (typeof mod.PlaidClient[n] === 'function') methods.push(n);
process.stdout.write(
  JSON.stringify({ exports: Object.keys(mod).filter((n) => n !== 'default'), methods, bundles }),
);
