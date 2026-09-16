// The resolve hook behind aliases.mjs. Kept in its own file because node loads
// hooks on a separate thread and will not take them from the module that
// registers them.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../../../', import.meta.url);
const PREFIXES = [
  ['@ui/', 'plaid-ui/src/'],
  ['@/', 'plaid-igt/src/'],
];

// Vite resolves an extensionless import and an index file; node does neither.
// App code is written against Vite, so both turn up behind these aliases.
const withExtension = (url) => {
  const path = fileURLToPath(url);
  if (existsSync(path) && !path.endsWith('/')) return url;
  for (const candidate of [`${path}.js`, `${path}.jsx`, `${path}/index.js`]) {
    if (existsSync(candidate)) return new URL(`file://${candidate}`).href;
  }
  return url;
};

export async function resolve(specifier, context, nextResolve) {
  for (const [alias, dir] of PREFIXES) {
    if (specifier.startsWith(alias)) {
      const target = new URL(dir + specifier.slice(alias.length), REPO).href;
      return nextResolve(withExtension(target), context);
    }
  }
  return nextResolve(specifier, context);
}
