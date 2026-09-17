// plaid-core's final table layout, read from its migrations, and every
// `setConfig` call site in plaid-igt and plaid-ui, read from their source.
// fidelity.test.js holds both against the catalog, so a new table, column or
// config key cannot land without somebody saying whether it is project data a
// format has to carry.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Split a string on commas that are not inside parentheses or quotes.
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

// The text between the parenthesis at `open` and its match.
function balanced(s, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return s.slice(open + 1, i);
  }
  throw new Error(`unbalanced parenthesis at ${open}`);
}

const CONSTRAINT = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i;

/** `{table: Set(columns)}` after applying every `*.up.sql` in order. */
export function coreSchema(migrationsDir) {
  const tables = new Map();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.up.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const stmt of sql.split(/;\s*(?:\n|$)/)) {
      const create = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/i.exec(stmt);
      if (create) {
        const body = balanced(stmt, create.index + create[0].length - 1);
        const cols = splitTopLevel(body)
          .filter((line) => !CONSTRAINT.test(line))
          .map((line) => line.split(/\s+/)[0]);
        tables.set(create[1], new Set(cols));
        continue;
      }
      const drop = /DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(stmt);
      if (drop) {
        tables.delete(drop[1]);
        continue;
      }
      const rename = /ALTER TABLE (\w+) RENAME TO (\w+)/i.exec(stmt);
      if (rename) {
        tables.set(rename[2], tables.get(rename[1]));
        tables.delete(rename[1]);
        continue;
      }
      const add = /ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(stmt);
      if (add) {
        tables.get(add[1]).add(add[2]);
        continue;
      }
      const dropCol = /ALTER TABLE (\w+) DROP COLUMN (\w+)/i.exec(stmt);
      if (dropCol) {
        tables.get(dropCol[1]).delete(dropCol[2]);
        continue;
      }
      const renameCol = /ALTER TABLE (\w+) RENAME COLUMN (\w+) TO (\w+)/i.exec(stmt);
      if (renameCol) {
        const cols = tables.get(renameCol[1]);
        cols.delete(renameCol[2]);
        cols.add(renameCol[3]);
      }
    }
  }
  return tables;
}

const RESOURCE =
  /\b(projects|textLayers|tokenLayers|spanLayers|relationLayers|vocabLayers)\.setConfig\(/g;

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((f) => /\.(js|jsx|mjs)$/.test(f) && !/\.(test|spec)\./.test(f))
    .map((f) => join(dir, f));
}

/**
 * Every `<resource>.setConfig(target, namespace, key, ...)` call in the given
 * source trees: `[{file, resource, namespace, key}]`, with namespace and key
 * as the source spells them (a quoted literal, or an identifier).
 */
export function setConfigCalls(roots) {
  const out = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(RESOURCE)) {
        const args = splitTopLevel(balanced(src, m.index + m[0].length - 1));
        out.push({ file, resource: m[1], namespace: args[1], key: args[2] });
      }
    }
  }
  return out;
}
