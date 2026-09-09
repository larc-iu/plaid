import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Invariants every DataTable call site has to hold, checked against the source
// rather than by rendering. Both DataTable bugs that reached master were of
// this shape and were caught by a person looking at a page: two tables with no
// `id` (so they silently remembered nothing), and a sortable column with a
// blank heading (a bare clickable nothing). Neither is visible to a component
// test, because neither screen has one.
//
// A static read is a crude tool and it is the right one here: the property is
// "this prop is present at this call site", which is exactly what a reader of
// the source can see and a renderer cannot.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.isFile() && /\.jsx$/.test(e.name) && !/\.test\.jsx$/.test(e.name) ? [full] : [];
  });

// Every `<DataTable ... />` in the app, as {file, line, props-text}.
const callSites = () =>
  sources(path.join(root, 'components')).flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return [...text.matchAll(/<DataTable\b([\s\S]*?)\/>/g)]
      .filter((m) => !m[1].includes('{...props}'))
      .map((m) => ({
        file: path.relative(root, file),
        line: text.slice(0, m.index).split('\n').length,
        props: m[1],
      }));
  });

const at = (site) => `${site.file}:${site.line}`;

// Every `{...}` in `text` with its braces balanced, so a column object is seen
// whole however much JSX its `render` holds.
const objectLiterals = (text) => {
  const out = [];
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') stack.push(i);
    else if (text[i] === '}' && stack.length) {
      const start = stack.pop();
      out.push({ text: text.slice(start, i + 1), line: text.slice(0, start).split('\n').length });
    }
  }
  return out;
};

// An object's OWN keys: nested `{...}` removed, so a column is judged on what
// it declares and an enclosing array is not judged on what its columns do.
const ownKeys = (text) => {
  let out = '';
  let depth = 0;
  for (let i = 1; i < text.length - 1; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
    else if (depth === 0) out += text[i];
  }
  return out;
};

describe('DataTable call sites', () => {
  it('finds the tables, so a passing run is not an empty one', () => {
    expect(callSites().length).toBeGreaterThan(10);
  });

  it('all name themselves, so each remembers its own order', () => {
    const unnamed = callSites().filter((s) => !/\bid=/.test(s.props));
    expect(unnamed.map(at)).toEqual([]);
  });

  it('all say how to key a row, so React is never keying on an index', () => {
    const unkeyed = callSites().filter((s) => !/\browKey=/.test(s.props));
    expect(unkeyed.map(at)).toEqual([]);
  });

  it('never make a blank heading sortable', () => {
    // A column with `sort` and no `label` renders a clickable heading with
    // nothing in it. Action columns are the ones with a blank label, and they
    // must not declare a sort accessor.
    //
    // Scanned over the whole file with balanced braces, not with a regex over
    // the call site: a column's `render` is usually JSX full of braces, and
    // most screens declare `columns` outside the JSX entirely, so both would
    // hide from anything simpler.
    const offenders = [];
    for (const file of sources(path.join(root, 'components'))) {
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes('<DataTable')) continue;
      for (const block of objectLiterals(text)) {
        const own = ownKeys(block.text);
        if (/label:\s*(''|"")/.test(own) && /(^|[\s,])sort:/.test(own)) {
          offenders.push(`${path.relative(root, file)}:${block.line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
