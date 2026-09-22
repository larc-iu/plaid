import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appTrees, repoRoot } from './apps.js';

// Every exported name in the shared package and the three live apps has at least
// one importer somewhere else in the tree. An export nobody imports is either
// dead code or a module-private helper that was published by habit, and both
// read to the next person as "something out there depends on this".
//
// This started as a hand-run census during the 2026-09-13 cleanup pass. It is a
// test now because the census is only true on the day it is run: every screen
// that moves into plaid-ui leaves a re-export behind, and the last caller of one
// goes quietly.
//
// A static read is the right tool. The property is "somebody names this
// identifier in an import", which is what a resolver sees and a renderer never
// does, and the answer has to cover the e2e specs and the Python agent's mirror
// runner as well as the app code.
//
// What counts as an importer, deliberately wide: a test file, an e2e spec, the
// plaid-dict prototype, a namespace import, a `lazyNamed(() => import(x), 'N')`
// route screen, a re-export chain. Anything that reduces false positives, since
// a false positive here reads as an invitation to delete live code.

const repo = repoRoot();

// Read for their IMPORTS. Wider than the census below on purpose: a tree here
// can keep an export alive but is never blamed for a dead one. plaid-dict is a
// stale prototype nobody maintains, so it is read but never judged, and
// plaid-agent/tests holds the mirror runner that loads two IGT modules whole.
const IMPORTER_TREES = [
  'plaid-ui/src',
  'plaid-ui/e2e',
  ...appTrees('src', 'e2e', 'test'),
  'plaid-dict/src',
  'plaid-agent/tests',
  'plaid-client-js/test',
];

// Where a dead export is a finding: every live app (`./apps.js`) and the
// package they share, plus the e2e helper modules beside their specs. Both
// lists read that one roster, so a fourth app is judged the day it arrives
// rather than two weeks later.
const CENSUS_TREES = ['plaid-ui/src', 'plaid-ui/e2e', ...appTrees('src', 'e2e')];

const SOURCE = /\.(js|jsx|mjs)$/;

const walk = (dir) => {
  const full = path.join(repo, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    const child = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(child);
    return e.isFile() && SOURCE.test(e.name) ? [child] : [];
  });
};

// The package's own tests sit at its root beside the file they guard
// (tailwindPreset.test.js does), so the root is read as well as src.
const looseFiles = (dir) =>
  fs
    .readdirSync(path.join(repo, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && SOURCE.test(e.name))
    .map((e) => `${dir}/${e.name}`);

const importerFiles = [...new Set([...IMPORTER_TREES.flatMap(walk), ...looseFiles('plaid-ui')])];
const text = new Map(importerFiles.map((f) => [f, fs.readFileSync(path.join(repo, f), 'utf8')]));

// ---------------------------------------------------------------------------
// Resolving a module specifier

const aliasOf = (spec, fromFile) => {
  if (spec.startsWith('@ui/')) return `plaid-ui/src/${spec.slice(4)}`;
  if (spec.startsWith('@igt/')) return `plaid-igt/src/${spec.slice(5)}`;
  // `@` is each app's alias for its own src, so it means a different tree
  // depending on who wrote the line.
  if (spec.startsWith('@/')) return `${fromFile.split('/')[0]}/src/${spec.slice(2)}`;
  if (spec.startsWith('.')) {
    const abs = path.resolve(path.dirname(path.join(repo, fromFile)), spec);
    const rel = path.relative(repo, abs).split(path.sep).join('/');
    return rel.startsWith('..') ? null : rel;
  }
  return null;
};

const isFile = (rel) => {
  try {
    return fs.statSync(path.join(repo, rel)).isFile();
  } catch {
    return false;
  }
};

// Vite's resolution, minus the parts nothing in this repo uses: the extension
// the author left off, and a directory that means its index.
const resolveFile = (rel) => {
  if (!rel) return null;
  for (const cand of [rel, `${rel}.js`, `${rel}.jsx`, `${rel}/index.js`, `${rel}/index.jsx`]) {
    if (isFile(cand)) return cand;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Who imports what

// A static `import ... from` or `export ... from`.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
// A dynamic import, with whatever follows it on the same call. The lookahead
// does not CONSUME that tail: a consuming match swallows the next call site,
// which is how an earlier run of this census reported every other lazyNamed
// route screen as dead.
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)(?=([\s\S]{0,80}))/g;
// An import whose specifier is built from a variable resolves to nothing here,
// by choice. Matching the literal tail of a template would be a guess about
// file names rather than a resolution, and the one place in the repo that does
// it is named outright in MIRRORED_WHOLE below.

// module -> names imported from it, and the modules somebody took whole.
const imported = new Map();
const whole = new Set();

const take = (target, name) => {
  if (!target) return;
  if (!imported.has(target)) imported.set(target, new Set());
  imported.get(target).add(name);
};

for (const file of importerFiles) {
  const src = text.get(file);
  let m;

  while ((m = IMPORT_RE.exec(src))) {
    const clause = m[1].trim();
    const target = resolveFile(aliasOf(m[2], file));
    if (!target) continue;
    // `import * as X` and `export * from` both mean every name is in play.
    if (clause.startsWith('*') || clause.includes('* as')) {
      whole.add(target);
      continue;
    }
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) take(target, name);
      }
    }
    // Whatever is left outside the braces is the default binding.
    const def = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, ' ')
      .trim();
    if (def) take(target, 'default');
  }

  while ((m = DYNAMIC_RE.exec(src))) {
    const target = resolveFile(aliasOf(m[1], file));
    if (!target) continue;
    // `lazyNamed(() => import('./Screen.jsx'), 'Screen')` names its export.
    const named = /^\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/.exec(m[2]);
    if (named) take(target, named[1]);
    else whole.add(target);
  }
}

// ---------------------------------------------------------------------------
// What each file exports

const exportsOf = (src) => {
  const names = [];
  const lineOf = (index) => src.slice(0, index).split('\n').length;
  let m;

  const declared =
    /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = declared.exec(src))) names.push({ name: m[1], line: lineOf(m.index) });

  const listed = /^export\s*\{([^}]*)\}\s*(from\s*['"][^'"]+['"])?\s*;?/gm;
  while ((m = listed.exec(src))) {
    const line = lineOf(m.index);
    const reexport = !!m[2];
    for (const part of m[1].split(',')) {
      const halves = part.trim().split(/\s+as\s+/);
      const name = (halves[1] || halves[0] || '').trim();
      // A default export is a module's own identity rather than a name, and an
      // app entry point or a route screen has one nobody imports by name.
      if (name && name !== 'default') names.push({ name, line, reexport });
    }
  }

  return names;
};

// ---------------------------------------------------------------------------
// What is exempt, each for a reason that is not "it looked dead"

// Vendored shadcn. These files are upstream's, kept as they arrived so the next
// component pulled from shadcn drops in beside them, and upstream exports the
// whole primitive whether or not this repo draws every part of it. Bespoke
// components live in components/shared/ and are censused. See memory
// plaid-ui-package, "Layout rules settled 2026-09-13".
const VENDORED = /\/components\/ui\//;

// The plaid-agent vocab mirror loads these two whole, with
// `import(`${DOMAIN}/vocabFields.js`)`, and a specifier built from a variable
// is not something any resolver can follow back to a name. What keeps them
// honest is the Python port: plaid-agent/tests/test_vocab_mirror.py asserts
// against every function each of them exports.
const MIRRORED_WHOLE = new Set([
  'plaid-igt/src/domain/vocabDictionary.js',
  'plaid-igt/src/domain/vocabFields.js',
]);

// Anything an index.html hands Vite as a module entry. Nothing imports an entry
// point, the bundler starts at it.
const viteEntries = () => {
  const found = new Set();
  for (const app of ['plaid-ui', 'plaid-igt', 'plaid-ud', 'plaid-umr', 'plaid-dict']) {
    const html = path.join(repo, app, 'index.html');
    if (!fs.existsSync(html)) continue;
    const src = fs.readFileSync(html, 'utf8');
    for (const m of src.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) {
      const rel = resolveFile(path.posix.join(app, m[1]));
      if (rel) found.add(rel);
    }
  }
  return found;
};

// Anything a package.json publishes. A package entry is imported by its bare
// name from outside this repo, which no scan of these trees can see.
const packageEntries = () => {
  const found = new Set();
  const collect = (dir, value) => {
    if (typeof value === 'string') {
      const rel = resolveFile(path.posix.join(dir, value));
      if (rel) found.add(rel);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) collect(dir, child);
    }
  };
  for (const dir of [
    'plaid-ui',
    'plaid-igt',
    'plaid-ud',
    'plaid-umr',
    'plaid-dict',
    'plaid-client-js',
  ]) {
    const file = path.join(repo, dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const field of ['main', 'module', 'exports', 'bin']) collect(dir, pkg[field]);
  }
  return found;
};

const ENTRY_POINTS = new Set([...viteEntries(), ...packageEntries()]);

const exemptFile = (file) =>
  VENDORED.test(file) || MIRRORED_WHOLE.has(file) || ENTRY_POINTS.has(file);

// Exempt NAMES, `file:name` to the reason it stays. Keep this list short and
// keep every entry a sentence somebody can disagree with.
const EXEMPT_NAMES = {
  // plaid-ud's feedback.jsx exists to be the one import site for a screen's
  // toasts, and it re-exports all six of notify.js's forms for that reason. Only
  // three of them have a caller through it today. They are listed here rather
  // than deleted because the file's promise is the full set: a screen that needs
  // notifyPromise should not have to learn that this one is imported from
  // somewhere else.
  'plaid-ud/src/utils/feedback.jsx:notifyInfo': 'one import site for every toast form',
  'plaid-ud/src/utils/feedback.jsx:notifyPromise': 'one import site for every toast form',
  'plaid-ud/src/utils/feedback.jsx:notifyWithAction': 'one import site for every toast form',
  // A node module-resolution hook. Node calls it on the loader thread, by name,
  // from a file it was handed at `register()`: there is no importer anywhere and
  // there cannot be one.
  'plaid-igt/e2e/live/aliasHooks.mjs:resolve': 'a node loader hook, called by the runtime',
  // plaid-umr's feedback.jsx is plaid-ud's, and re-exports the full set for the
  // same reason: it is the one import site for a screen's toasts.
  'plaid-umr/src/utils/feedback.jsx:notifyInfo': 'one import site for every toast form',
  'plaid-umr/src/utils/feedback.jsx:notifyPromise': 'one import site for every toast form',
  'plaid-umr/src/utils/feedback.jsx:notifyWithAction': 'one import site for every toast form',
};

// plaid-umr joined the census on 2026-09-21, four months after it was written,
// and arrived carrying these. They are NOT exempt and none of them has a
// reason: each is either a module-private helper that was published by habit or
// a name whose last caller went quietly. They are listed rather than deleted
// because that pass is plaid-umr's to make and this file belongs to the shared
// package. The list only ever gets shorter: a dead export NOT on it fails the
// run today, and an entry somebody has since dealt with is warned about, the
// way a spent exemption is.
// plaid-umr's dead exports, cleared 2026-09-21: the ones used only inside
// their own file lost the keyword, the ones nothing named at all went. Kept
// as an empty set rather than removed, so the next umr finding has an
// obvious place to be parked and this comment says what happened to the
// last one.
const UMR_BACKLOG = new Set([]);

// ---------------------------------------------------------------------------
// The census

const censusFiles = [...new Set(CENSUS_TREES.flatMap(walk))].filter((f) => !exemptFile(f));

const findings = [];
const exemptionsUsed = new Set();
const backlogSeen = new Set();

for (const file of censusFiles) {
  if (whole.has(file)) continue;
  const src = text.get(file);
  const takers = imported.get(file) || new Set();
  for (const { name, line, reexport } of exportsOf(src)) {
    if (takers.has(name)) continue;
    const key = `${file}:${name}`;
    if (key in EXEMPT_NAMES) {
      exemptionsUsed.add(key);
      continue;
    }
    if (UMR_BACKLOG.has(key)) {
      backlogSeen.add(key);
      continue;
    }
    // How the name is used inside its own file, which is what tells a
    // module-private helper that should lose its `export` from a name nothing
    // anywhere mentions twice. JSX counts: `<Name` never reads as a reference
    // to a plain word search.
    const word = name.replace(/\$/g, '\\$');
    const mentions = (src.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length;
    const jsx = (src.match(new RegExp(`</?${word}[\\s/>]`, 'g')) || []).length;
    const kind = reexport
      ? 're-exported, nobody takes it'
      : mentions > 1 || jsx > 0
        ? 'used only inside its own file'
        : 'nothing mentions it';
    findings.push(`${file}:${line} ${name} (${kind})`);
  }
}

describe('exported names', () => {
  it('finds the tree, so a passing run is not an empty one', () => {
    expect(censusFiles.length).toBeGreaterThan(500);
    expect(imported.size).toBeGreaterThan(500);
  });

  it('resolves the lazy route screens, the census bug that hid half of them', () => {
    // Two consecutive `lazyNamed(() => import(...), 'Name')` calls sit one line
    // apart in both apps' App.jsx. A consuming lookahead over the tail of the
    // first match ate the second call, and every other route screen in both
    // apps came back dead. Every call site, checked against what the scan above
    // recorded.
    const CALL =
      /lazyNamed\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/g;
    const missed = [];
    let seen = 0;
    // This file quotes the form it is checking, in a comment, and a scan cannot
    // tell that from a call.
    const self = path
      .relative(repo, fileURLToPath(import.meta.url))
      .split(path.sep)
      .join('/');
    for (const file of importerFiles) {
      if (file === self) continue;
      for (const m of text.get(file).matchAll(CALL)) {
        seen += 1;
        const target = resolveFile(aliasOf(m[1], file));
        if (!target || !(imported.get(target) || new Set()).has(m[2])) {
          missed.push(`${file}: ${m[2]}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(missed).toEqual([]);
  });

  it('all have an importer outside their own file', () => {
    expect(findings).toEqual([]);
  });

  it('names a real file in every exemption it is given', () => {
    const missing = Object.keys(EXEMPT_NAMES).filter((key) => {
      const file = key.slice(0, key.lastIndexOf(':'));
      return !isFile(file);
    });
    expect(missing).toEqual([]);

    // An exemption that is no longer needed is a warning rather than a failure,
    // the way a stale assistant surface entry is. Somebody deleting the last
    // dead export should not have to come back here to get a green run.
    const stale = [
      ...Object.keys(EXEMPT_NAMES).filter((key) => !exemptionsUsed.has(key)),
      ...[...UMR_BACKLOG].filter((key) => !backlogSeen.has(key)),
    ];
    if (stale.length) {
      console.warn(`Dead-export exemptions no longer needed: ${stale.join(', ')}`);
    }
  });
});
