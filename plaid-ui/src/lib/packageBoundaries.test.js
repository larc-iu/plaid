import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Three things a file in this package must not know, each of which has already
// cost something:
//
//  - `@ui`, the apps' alias for this package. Resolving a package file through
//    it puts that module under node_modules, where Vite pre-bundles it, and the
//    same module then exists twice: `configureUi` wrote to one copy while the
//    hooks read the other, and compose codes went dead in every field.
//  - an app's ROUTES. plaid-igt opens a document at /projects/:p/documents/:d
//    and plaid-ud at the same path plus /annotate, so a default here sends half
//    the readers of a shared screen to a page that is not theirs.
//  - an app's NAME on screen. The package is what the apps have in common.
//
// Comments are exempt: naming the thing is how they explain it.

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');

// Every app URL in one place, by design: this is where an app reaches its
// sibling, which is the one thing the package does know about them.
const SIBLING_APPS = path.join(src, 'domain', 'siblingApps.js');

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.isFile() && /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [full] : [];
  });

// A line of code, or a line of prose about it.
const isComment = (line) => /^\s*(\/\/|\/?\*)/.test(line);

const offenders = (pattern, { skip = [] } = {}) => {
  const found = [];
  for (const file of sources(src)) {
    if (skip.includes(file)) continue;
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (isComment(line) || !pattern.test(line)) return;
        found.push(`${path.relative(src, file)}:${i + 1}`);
      });
  }
  return found;
};

describe('what a package file may not know', () => {
  it('does not import itself through the apps’ alias', () => {
    expect(offenders(/from\s+['"]@ui\//)).toEqual([]);
  });

  it('holds no app’s routes', () => {
    // Every segment either app routes on, matched ANYWHERE inside a string
    // rather than only at its start: half the paths a component builds are
    // interpolated (`${projectPath}/annotate`), and a pattern anchored to the
    // opening quote reads those as clean.
    const SEGMENTS = [
      'projects',
      'documents',
      'vocabularies',
      'profile',
      'admin',
      'login',
      'annotate',
      'edit',
      'settings',
      'assistant',
      'export',
      'import',
      'tokenize',
      'analyze',
    ].join('|');
    const ROUTE = new RegExp(`['"\`][^'"\`]*/(${SEGMENTS})\\b`);
    expect(offenders(ROUTE, { skip: [SIBLING_APPS] })).toEqual([]);
  });

  it('names neither app on screen', () => {
    // In a string, not in an identifier: `IGT_URL` is this package's own name
    // for a sibling's address, and that is what siblingApps.js is.
    const NAMED = /['"`][^'"`]*\b(Plaid IGT|Plaid UD|interlinear|treebank)\b/i;
    expect(offenders(NAMED, { skip: [SIBLING_APPS] })).toEqual([]);
  });
});
